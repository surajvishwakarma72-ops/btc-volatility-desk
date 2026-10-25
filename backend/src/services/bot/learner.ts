import { DEFAULT_THRESHOLDS, evaluateStrategy, inCooldown, type LearnParams, type StrategyEvaluation } from '../../lib/bot/learn.js';
import { getParams, lastLearningMs, loadTraces, logEvent, logLearning, setParams } from './bot-store.js';

/** The strategies whose rules are learned. Long straddles and the calendar keep fixed rules for now. */
export const LEARNED_STRATEGIES = ['ASIA_SHORT', 'NY_SHORT'] as const;

const LOOKBACK_MS = 120 * 86_400_000;

export interface LearnReport {
  strategy: string;
  champion: LearnParams;
  days: number;
  promoted: boolean;
  note: string;
  evaluation: StrategyEvaluation;
}

export const autoLearnOn = () => (process.env.BOT_AUTO_LEARN ?? 'true') !== 'false';

/**
 * Evaluates every challenger against the current champion on the bot's own recorded days and, when `apply`
 * is set and a challenger clears every bar, promotes it. Paper only: it changes the numbers the paper engine
 * uses for NEW runs; open runs keep the rules they started with.
 */
export async function runLearning(nowMs: number, apply: boolean): Promise<LearnReport[]> {
  const out: LearnReport[] = [];
  for (const strategy of LEARNED_STRATEGIES) {
    const champion = await getParams(strategy);
    const traces = await loadTraces(strategy, nowMs - LOOKBACK_MS);
    const ev = evaluateStrategy(strategy, traces, champion, DEFAULT_THRESHOLDS);
    let promoted = false;
    let note: string;
    const lastPromo = await lastLearningMs(strategy, 'promotion');
    if (ev.days < DEFAULT_THRESHOLDS.minDays) {
      note = `Collecting data: ${ev.days} of ${DEFAULT_THRESHOLDS.minDays} full days recorded, so no rule change is considered yet.`;
    } else if (!ev.promote) {
      const best = [...ev.challengers].sort((a, b) => b.stats.t - a.stats.t)[0];
      note = best
        ? `Champion kept. Closest challenger: ${best.changed} ${best.params[best.changed]} (${best.stats.meanDiff >= 0 ? '+' : ''}${best.stats.meanDiff.toFixed(2)} USD/day, ${best.failed[0] ?? 'not significant'}).`
        : 'Champion kept: no challengers to test.';
    } else if (inCooldown(lastPromo, nowMs)) {
      note = `A challenger qualified (${ev.promote.reason}) but the strategy was changed less than ${DEFAULT_THRESHOLDS.cooldownDays} days ago, so it waits.`;
    } else if (!apply) {
      note = `A challenger qualified (${ev.promote.reason}) but automatic promotion is off, so nothing was changed.`;
    } else {
      await setParams(strategy, ev.promote.to);
      await logLearning({ strategy, kind: 'promotion', from: champion, to: ev.promote.to, reason: ev.promote.reason, evidence: slim(ev) });
      await logEvent({ strategy, type: 'learn_promotion', message: `auto-learn promoted a new rule: ${ev.promote.reason}`, data: { from: champion, to: ev.promote.to } });
      promoted = true;
      note = `Promoted: ${ev.promote.reason}`;
    }
    await logLearning({ strategy, kind: 'evaluation', from: champion, reason: note, evidence: slim(ev) });
    out.push({ strategy, champion: promoted ? ev.promote!.to : champion, days: ev.days, promoted, note, evaluation: ev });
  }
  return out;
}

/** Puts the strategy back on the parameters it had before its latest promotion. */
export async function rollbackLast(strategy: string): Promise<{ restored: LearnParams } | null> {
  const { pool } = await import('../../db/index.js');
  const r = await pool.query<{ from_params: LearnParams; to_params: LearnParams }>(
    `SELECT from_params, to_params FROM bot_learning WHERE strategy = $1 AND kind = 'promotion' ORDER BY at DESC, id DESC LIMIT 1`,
    [strategy],
  );
  const row = r.rows[0];
  if (!row) return null;
  const current = await getParams(strategy);
  await setParams(strategy, row.from_params);
  await logLearning({ strategy, kind: 'rollback', from: current, to: row.from_params, reason: 'rolled back to the rules in use before the latest promotion' });
  await logEvent({ strategy, type: 'learn_rollback', severity: 'warn', message: 'auto-learn rule change rolled back', data: { from: current, to: row.from_params } });
  return { restored: row.from_params };
}

/** Compact evidence for the log: the champion's numbers and every challenger's verdict. */
function slim(ev: StrategyEvaluation) {
  return {
    days: ev.days,
    championMeanPerDay: ev.championMeanPerDay,
    championMaxDrawdown: ev.championMaxDrawdown,
    challengers: ev.challengers.map((c) => ({
      experiment: c.experiment, changed: c.changed, value: c.params[c.changed], meanPerDay: c.meanPerDay,
      gainPerDay: c.stats.meanDiff, t: Number.isFinite(c.stats.t) ? c.stats.t : null, p: c.stats.p, maxDrawdown: c.maxDrawdown, qualifies: c.qualifies, failed: c.failed,
    })),
  };
}
