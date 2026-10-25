import { computePnl, evaluateExit } from './rules.js';
import type { ExitConfig, Leg } from './types.js';

/**
 * Auto-learn: champion versus challenger, paper only.
 *
 * The champion is the rule set the bot is trading with now. Challengers are the same rules with ONE
 * knob changed (stop multiple, take-profit level, or the gate's DVOL limit). Every challenger is
 * replayed over the bot's own recorded minute-by-minute marks, on the same days as the champion, so
 * the comparison is paired: only days where the rules behave differently matter.
 *
 * A challenger is promoted only if it clears every bar below. The bars are deliberately hard:
 * a few weeks of data and a dozen challengers will always produce a lucky one, so a promotion needs
 * enough days, a real margin, a significance level corrected for the number of challengers, and no
 * worse a drawdown. Nothing here can touch real money; every promotion is logged and reversible.
 */
export interface LearnParams {
  /** Gated book trades only while DVOL is below this. */
  dvolMax: number;
  /** Close everything when a sold leg reaches this multiple of its entry price. */
  stopMultiple: number;
  /** Take profit as a fraction of margin. */
  tpPct: number;
}

export const DEFAULT_PARAMS: LearnParams = { dvolMax: 65, stopMultiple: 2, tpPct: 0.1 };

export const PARAM_GRID: { [K in keyof LearnParams]: number[] } = {
  dvolMax: [45, 50, 55, 60, 65, 70, 80, 1000],
  stopMultiple: [1.5, 2, 2.5, 3],
  tpPct: [0.05, 0.1, 0.15, 0.2],
};

export interface LearnThresholds {
  /** Fewest paired days before any promotion. */
  minDays: number;
  /** Required gain per day over the champion, in USD. */
  minGainUsd: number;
  /** ...and as a fraction of the champion's own average (whichever is larger applies). */
  minGainFrac: number;
  /** Family-wise significance level, split across all challengers (Bonferroni). */
  alpha: number;
  /** Challenger's max drawdown may be at most this multiple of the champion's. */
  maxDrawdownRatio: number;
  /** Days that must pass between promotions of the same strategy. */
  cooldownDays: number;
}

export const DEFAULT_THRESHOLDS: LearnThresholds = {
  minDays: 30,
  minGainUsd: 0.25,
  minGainFrac: 0.15,
  alpha: 0.05,
  maxDrawdownRatio: 1.25,
  cooldownDays: 14,
};

/** One recorded run with the minute marks needed to replay different rules over it. */
export interface RunTrace {
  strategy: string;
  dateKey: string;
  marginUsd: number;
  feesEntry: number;
  feesExit: number;
  dvol: number | null;
  macroZone: string | null;
  legs: Leg[];
  /** Planned time exit (epoch ms): never moves, whatever the rules. */
  exitAtMs: number;
  /** Minute marks, chronological; `marks[i]` is the mark of `legs[i]`. */
  minutes: Array<{ t: number; spot: number; marks: number[] }>;
  /** The minute data reaches the planned exit, so any rule can be replayed to its end. */
  complete: boolean;
}

const CONTRACT_VALUE = 0.001;

/** Net PnL of one run under the given exit rules (marks at mid, the actual exit fee), or null with no data. */
export function simulateExit(trace: RunTrace, rules: Pick<LearnParams, 'stopMultiple' | 'tpPct'>): number | null {
  const cfg: ExitConfig = { stopMultiple: rules.stopMultiple, tpPctOfMargin: rules.tpPct, exitAtMs: trace.exitAtMs };
  let last: number | null = null;
  for (const m of trace.minutes) {
    if (m.marks.length !== trace.legs.length || m.marks.some((x) => !Number.isFinite(x))) continue;
    const snap = {
      legs: trace.legs,
      marks: trace.legs.map((l, i) => ({ symbol: l.symbol, mark: m.marks[i]! })),
      spot: m.spot,
      marginUsd: trace.marginUsd,
      contractValue: CONTRACT_VALUE,
      feesPaidUsd: trace.feesEntry,
    };
    const pnl = computePnl(snap).netPnl;
    last = pnl;
    if (evaluateExit(snap, cfg, m.t).action === 'exit') return pnl - trace.feesExit;
  }
  return last == null ? null : last - trace.feesExit;
}

/** Would the gated book have traded this day under a DVOL limit of `dvolMax`? (Macro zone must be calm, as the live gate requires.) */
export function gatePasses(trace: Pick<RunTrace, 'dvol' | 'macroZone'>, dvolMax: number): boolean {
  return trace.dvol != null && trace.dvol < dvolMax && (trace.macroZone == null || trace.macroZone === 'calm');
}

// ---------- statistics ----------

/** Standard normal upper-tail probability. */
export function normalUpperTail(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? p : 1 - p;
}

export function maxDrawdown(series: readonly number[]): number {
  let eq = 0;
  let top = 0;
  let dd = 0;
  for (const x of series) {
    eq += x;
    top = Math.max(top, eq);
    dd = Math.max(dd, top - eq);
  }
  return dd;
}

export interface PairedStats {
  days: number;
  meanDiff: number;
  t: number;
  /** One-sided p-value that the challenger is better (normal approximation, fine from ~30 days). */
  p: number;
}

export function pairedStats(challenger: readonly number[], champion: readonly number[]): PairedStats {
  const n = Math.min(challenger.length, champion.length);
  const d = Array.from({ length: n }, (_, i) => challenger[i]! - champion[i]!);
  const mean = n ? d.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  if (sd === 0) return { days: n, meanDiff: mean, t: mean > 0 ? Infinity : mean < 0 ? -Infinity : 0, p: mean > 0 ? 0 : 1 };
  const t = mean / (sd / Math.sqrt(n));
  return { days: n, meanDiff: mean, t, p: normalUpperTail(t) };
}

// ---------- experiments ----------

export type Experiment = 'exit' | 'gate';

export interface ChallengerResult {
  experiment: Experiment;
  changed: keyof LearnParams;
  params: LearnParams;
  meanPerDay: number;
  stats: PairedStats;
  maxDrawdown: number;
  qualifies: boolean;
  /** Why it did not qualify (empty when it does). */
  failed: string[];
}

export interface StrategyEvaluation {
  strategy: string;
  champion: LearnParams;
  days: number;
  championMeanPerDay: { exit: number; gate: number };
  championMaxDrawdown: { exit: number; gate: number };
  challengers: ChallengerResult[];
  promote: { experiment: Experiment; changed: keyof LearnParams; to: LearnParams; reason: string } | null;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? 'off' : String(v));

/**
 * Replays the champion and every one-knob challenger over the same days and reports who beats whom.
 * `traces` should be one trace per day (the always-book run), complete ones only.
 */
export function evaluateStrategy(
  strategy: string,
  traces: readonly RunTrace[],
  champion: LearnParams,
  th: LearnThresholds = DEFAULT_THRESHOLDS,
): StrategyEvaluation {
  const days = traces.filter((t) => t.complete && t.strategy === strategy).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const exitDaily = (r: Pick<LearnParams, 'stopMultiple' | 'tpPct'>) => days.map((t) => simulateExit(t, r) ?? 0);
  const gateDaily = (dvolMax: number) => days.map((t, i) => (gatePasses(t, dvolMax) ? champExit[i]! : 0));
  const champExit = exitDaily(champion);
  const champGate = gateDaily(champion.dvolMax);
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

  const list: Array<{ experiment: Experiment; changed: keyof LearnParams; params: LearnParams; series: number[]; base: number[] }> = [];
  for (const v of PARAM_GRID.stopMultiple) {
    if (v !== champion.stopMultiple) list.push({ experiment: 'exit', changed: 'stopMultiple', params: { ...champion, stopMultiple: v }, series: exitDaily({ stopMultiple: v, tpPct: champion.tpPct }), base: champExit });
  }
  for (const v of PARAM_GRID.tpPct) {
    if (v !== champion.tpPct) list.push({ experiment: 'exit', changed: 'tpPct', params: { ...champion, tpPct: v }, series: exitDaily({ stopMultiple: champion.stopMultiple, tpPct: v }), base: champExit });
  }
  for (const v of PARAM_GRID.dvolMax) {
    if (v !== champion.dvolMax) list.push({ experiment: 'gate', changed: 'dvolMax', params: { ...champion, dvolMax: v }, series: gateDaily(v), base: champGate });
  }

  const challengers: ChallengerResult[] = list.map((c) => {
    const stats = pairedStats(c.series, c.base);
    const dd = maxDrawdown(c.series);
    const baseDd = maxDrawdown(c.base);
    const baseMean = mean(c.base);
    const needGain = Math.max(th.minGainUsd, th.minGainFrac * Math.abs(baseMean));
    const sameExperiment = list.filter((x) => x.experiment === c.experiment).length;
    const failed: string[] = [];
    if (stats.days < th.minDays) failed.push(`only ${stats.days} days of data (need ${th.minDays})`);
    if (stats.meanDiff < needGain) failed.push(`gain ${stats.meanDiff.toFixed(2)} USD/day is under the ${needGain.toFixed(2)} needed`);
    if (!(stats.p < th.alpha / sameExperiment)) failed.push(`p=${stats.p.toFixed(3)} is not under ${(th.alpha / sameExperiment).toFixed(4)} (corrected for ${sameExperiment} challengers)`);
    if (dd > th.maxDrawdownRatio * Math.max(baseDd, 1e-9)) failed.push(`drawdown ${dd.toFixed(0)} is over ${th.maxDrawdownRatio}x the champion's ${baseDd.toFixed(0)}`);
    return { experiment: c.experiment, changed: c.changed, params: c.params, meanPerDay: mean(c.series), stats, maxDrawdown: dd, qualifies: failed.length === 0, failed };
  });

  // At most one change at a time, the most convincing one, so effects stay attributable.
  const winner = challengers.filter((c) => c.qualifies).sort((a, b) => b.stats.t - a.stats.t)[0] ?? null;
  const promote = winner
    ? {
        experiment: winner.experiment,
        changed: winner.changed,
        to: winner.params,
        reason:
          `${strategy}: ${winner.changed} ${fmt(champion[winner.changed])} -> ${fmt(winner.params[winner.changed])}. ` +
          `Over ${winner.stats.days} days it earned ${winner.meanPerDay.toFixed(2)} USD/day versus ${(winner.experiment === 'exit' ? mean(champExit) : mean(champGate)).toFixed(2)} for the champion ` +
          `(+${winner.stats.meanDiff.toFixed(2)}/day, t=${winner.stats.t.toFixed(2)}, p=${winner.stats.p.toFixed(4)}, corrected threshold met), ` +
          `max drawdown ${winner.maxDrawdown.toFixed(0)} vs ${maxDrawdown(winner.experiment === 'exit' ? champExit : champGate).toFixed(0)}.`,
      }
    : null;

  return {
    strategy,
    champion,
    days: days.length,
    championMeanPerDay: { exit: mean(champExit), gate: mean(champGate) },
    championMaxDrawdown: { exit: maxDrawdown(champExit), gate: maxDrawdown(champGate) },
    challengers,
    promote,
  };
}

/** Cooldown check: has the strategy been changed recently? */
export function inCooldown(lastPromotionMs: number | null, nowMs: number, th: LearnThresholds = DEFAULT_THRESHOLDS): boolean {
  return lastPromotionMs != null && nowMs - lastPromotionMs < th.cooldownDays * 86_400_000;
}

/** Clamp stored/learned params to the grid so a bad row can never put the bot outside tested ranges. */
export function sanitizeParams(p: Partial<LearnParams> | null | undefined): LearnParams {
  const pick = (k: keyof LearnParams) => {
    const v = p?.[k];
    return typeof v === 'number' && PARAM_GRID[k].includes(v) ? v : DEFAULT_PARAMS[k];
  };
  return { dvolMax: pick('dvolMax'), stopMultiple: pick('stopMultiple'), tpPct: pick('tpPct') };
}
