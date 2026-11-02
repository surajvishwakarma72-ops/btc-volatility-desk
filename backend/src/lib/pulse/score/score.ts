/** Strangle Pulse confidence score, zones and verdict. Pure: turns per-cohort metric steps into one reading per 15-minute grid. */
import { LINE_CONFIG, SCORE_CONFIG } from '../config.js';
import type { StepMetrics } from '../metrics/series.js';

type N = number | null;
export type Zone = 'sell' | 'caution' | 'avoid' | 'nodata';
export type Verdict = 'SELL NOW' | 'WAIT' | 'AVOID' | 'NO DATA';
export type Component = keyof typeof SCORE_CONFIG.weights;

export const COMPONENT_LABEL: Record<Component, string> = {
  decay: 'Time decay', realized: 'Realised vs implied move', delta: 'Delta stability', balance: 'Leg balance',
  iv: 'IV trend', oi: 'Open-interest support', futures: 'Futures direction', liquidity: 'Spread / liquidity',
};

const ok = (x: N | undefined): x is number => x !== null && x !== undefined && Number.isFinite(x);
/** Linear map: `bad` scores 0, `good` scores 100, clamped. Works in both directions. */
export const lin = (x: N | undefined, [bad, good]: readonly [number, number]): N => (ok(x) ? Math.max(0, Math.min(100, ((x - bad) / (good - bad)) * 100)) : null);
const avg = (xs: readonly N[]): N => {
  const v = xs.filter(ok);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
};

/** The eight 0-100 sub-scores of one step; null where the input is missing. */
export function subScores(s: StepMetrics): Record<Component, N> {
  const m = SCORE_CONFIG.map;
  const oi = (x: StepMetrics['oi_call']) => (x && x in SCORE_CONFIG.oiScore ? SCORE_CONFIG.oiScore[x as keyof typeof SCORE_CONFIG.oiScore] : null);
  return {
    decay: avg([lin(s.de_call, m.de), lin(s.de_put, m.de)]),
    realized: lin(s.range_ratio, m.rangeRatio),
    delta: avg([lin(s.dsi, m.dsi), lin(ok(s.net_delta) ? Math.abs(s.net_delta) : null, m.netDeltaAbs)]),
    balance: lin(s.balance_drift, m.balanceDrift),
    iv: avg([lin(s.iv_call_1h, m.ivChange1h), lin(s.iv_put_1h, m.ivChange1h)]),
    oi: avg([oi(s.oi_call), oi(s.oi_put)]),
    futures: avg([lin(s.efficiency_ratio, m.efficiency), lin(s.move_vs_breakeven, m.moveVsBreakeven)]),
    liquidity: s.liquidity ? SCORE_CONFIG.liquidityScore[s.liquidity] : null,
  };
}

/** Weighted score of one step, renormalised over the present components; null if too little is known. */
export function stepScore(s: StepMetrics): { score: number; parts: Record<Component, N> } | null {
  const parts = subScores(s);
  let w = 0;
  let sum = 0;
  for (const k of Object.keys(parts) as Component[]) {
    const v = parts[k];
    if (v === null) continue;
    w += SCORE_CONFIG.weights[k];
    sum += v * SCORE_CONFIG.weights[k];
  }
  return w < SCORE_CONFIG.minWeightPresent ? null : { score: sum / w, parts };
}

export interface CohortSteps { opened_at: number; steps: readonly StepMetrics[] }

/** Context that only exists now (not per past grid). Null means the input is unavailable. */
export interface LiveContext {
  gatePass: boolean | null;
  killer: boolean | null;
  termInverted: boolean | null;
  persistence: { side: string; count: number; n: number } | null;
  noValidStrikes: boolean;
}

export interface Reading {
  t: number;
  zone: Zone;
  verdict: Verdict;
  confidence: number | null;
  /** Unfiltered by hysteresis. */
  rawZone: Zone;
  /** True when the tape says SELL but the live gate is failing or unavailable. */
  gateBlocked: boolean;
  vetoes: string[];
  /** Weakest components first, plain words. */
  why: string[];
  /** The one change that would move it to the next zone. */
  flips: string | null;
  heavyLeg: 'call' | 'put' | null;
  parts: Record<Component, N> | null;
}

const VERDICT: Record<Zone, Verdict> = { sell: 'SELL NOW', caution: 'WAIT', avoid: 'AVOID', nodata: 'NO DATA' };

/** One reading at grid time t from the cohorts opened at or before it. Hysteresis is applied by `readings`. */
export function readingAt(t: number, cohorts: readonly CohortSteps[], live: LiveContext | null): Omit<Reading, 'zone' | 'verdict'> & { rawZone: Zone } {
  const empty = { t, confidence: null, rawZone: 'nodata' as Zone, gateBlocked: false, vetoes: [] as string[], why: [] as string[], flips: null, heavyLeg: null, parts: null };
  const eligible = cohorts.filter((c) => c.opened_at <= t).sort((a, b) => b.opened_at - a.opened_at);
  // Each cohort's newest step at or before t; a stale one is left out.
  const scored = eligible.flatMap((c) => {
    const step = [...c.steps].reverse().find((x) => x.sampled_ms <= t);
    if (!step || t - step.sampled_ms > SCORE_CONFIG.staleStepMs) return [];
    const sc = stepScore(step);
    return sc ? [{ step, ...sc }] : [];
  });
  // The newest cohort must be fresh, otherwise the whole reading is NO DATA (never SELL on broken inputs).
  const newestStep = eligible[0] && [...eligible[0].steps].reverse().find((x) => x.sampled_ms <= t);
  if (!newestStep || t - newestStep.sampled_ms > SCORE_CONFIG.staleStepMs || scored.length === 0) return empty;

  let acc = 0;
  let wsum = 0;
  let prev = 0;
  for (const g of SCORE_CONFIG.recency) {
    const grp = scored.slice(prev, g.upTo);
    prev = g.upTo;
    if (grp.length === 0) continue;
    acc += g.weight * (grp.reduce((a, c) => a + c.score, 0) / grp.length);
    wsum += g.weight;
  }
  let confidence = acc / wsum;

  const parts: Record<Component, N> = { decay: null, realized: null, delta: null, balance: null, iv: null, oi: null, futures: null, liquidity: null };
  for (const k of Object.keys(parts) as Component[]) parts[k] = avg(scored.slice(0, 3).map((c) => c.parts[k]));

  const vetoes: string[] = [];
  if (newestStep.spread_veto === true) vetoes.push('Spread too wide on a leg');
  if (live) {
    if (live.noValidStrikes) vetoes.push('Latest cohort found no valid strikes');
    if (live.persistence && live.persistence.n >= 6 && live.persistence.count >= 5) vetoes.push('Futures trending one way (' + live.persistence.count + ' of ' + live.persistence.n + ')');
    if (live.killer === true) vetoes.push('Killer pattern active (RVP and ADX rising)');
    if (live.termInverted === true) vetoes.push('Term structure inverted');
    if (live.gatePass === false) vetoes.push('Regime gate failed');
  }
  if (vetoes.length > 0) confidence = Math.min(confidence, SCORE_CONFIG.vetoCap);

  const z = SCORE_CONFIG.zones;
  let rawZone: Zone = vetoes.length > 0 || confidence < z.cautionMin ? 'avoid' : confidence < z.sellMin ? 'caution' : 'sell';
  // SELL also needs the regime gate; an unavailable gate can only reach WAIT.
  // History has no recorded gate, so past readings reflect the tape only; the newest reading carries the live gate.
  const gateBlocked = rawZone === 'sell' && live !== null && live.gatePass !== true;
  if (gateBlocked) rawZone = 'caution';

  const ranked = (Object.keys(parts) as Component[]).filter((k) => parts[k] !== null).sort((a, b) => (parts[a] as number) - (parts[b] as number));
  const why = vetoes.length > 0 ? vetoes : ranked.slice(0, 3).map((k) => `${COMPONENT_LABEL[k]} ${Math.round(parts[k] as number)}/100`);
  let flips: string | null = null;
  if (vetoes.length > 0) flips = 'Clear: ' + vetoes[0];
  else if (rawZone === 'caution' && confidence >= z.sellMin && live?.gatePass !== true) flips = 'Regime gate must pass';
  else if (rawZone !== 'sell' && ranked[0]) flips = `Improve ${COMPONENT_LABEL[ranked[0]].toLowerCase()} (${Math.round(parts[ranked[0]] as number)}/100)`;

  return { t, confidence: Math.round(confidence * 10) / 10, rawZone, gateBlocked, vetoes, why, flips, heavyLeg: newestStep.heavy_leg, parts };
}

/**
 * Readings for every grid in `gridTimes` (oldest first). A zone changes only after `hysteresisReadings` readings in a row on
 * the new side; NO DATA shows at once. Live-only vetoes apply to the newest reading only.
 */
export function readings(gridTimes: readonly number[], cohorts: readonly CohortSteps[], live: LiveContext | null): Reading[] {
  const out: Reading[] = [];
  let shown: Zone = 'nodata';
  let streak = 0;
  let pending: Zone | null = null;
  gridTimes.forEach((t, i) => {
    const r = readingAt(t, cohorts, i === gridTimes.length - 1 ? live : null);
    if (r.rawZone === 'nodata') { shown = 'nodata'; streak = 0; pending = null; }
    else if (r.gateBlocked) { shown = 'caution'; streak = 0; pending = null; }   // never sell on an unconfirmed gate
    else if (r.vetoes.length > 0) { shown = 'avoid'; streak = 0; pending = null; }   // a hard veto shows at once
    else if (shown === 'nodata' || r.rawZone === shown) { shown = r.rawZone; streak = 0; pending = null; }
    else {
      streak = pending === r.rawZone ? streak + 1 : 1;
      pending = r.rawZone;
      if (streak >= SCORE_CONFIG.hysteresisReadings) { shown = r.rawZone; streak = 0; pending = null; }
    }
    out.push({ ...r, zone: shown, verdict: VERDICT[shown] });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Risk lines: one 0-100 line each for the call leg, the put leg, the long futures and the short futures.

export interface Lines { call: N; put: N; futLong: N; futShort: N }

/** Calm-to-bad 0-100 map (higher = worse for a seller). */
const rk = (x: N | undefined, [calm, bad]: readonly [number, number]): N => lin(x, [calm, bad]);

/** A sold leg gets riskier as its IV rises, its decay stalls, its delta and gamma speed up, or buyers take the strike. */
function legRisk(iv1h: N, de: N, deltaSpeed: N, gammaSpeed: N, oi: StepMetrics['oi_call']): N {
  const m = LINE_CONFIG.map;
  const oiR = oi && oi in LINE_CONFIG.oiRisk ? LINE_CONFIG.oiRisk[oi as keyof typeof LINE_CONFIG.oiRisk] : null;
  return avg([rk(iv1h, m.ivChange1h), rk(de, m.decay), rk(deltaSpeed, m.deltaSpeed), rk(gammaSpeed, m.gammaSpeed), oiR]);
}

/** One step's four lines. The futures lines rise only on a move in their own direction, harder when the path is a straight line. */
export function stepLines(s: StepMetrics): Lines {
  const m = LINE_CONFIG.map;
  const up = s.move_norm !== null && s.move_norm > 0;
  const dn = s.move_norm !== null && s.move_norm < 0;
  const dir = (on: boolean): N => (s.move_norm === null ? null : !on ? 0 : avg([rk(Math.abs(s.move_norm), m.moveNorm), rk(s.efficiency_ratio, m.efficiency)]));
  return {
    call: legRisk(s.iv_call_1h, s.de_call, s.delta_speed_call, s.gamma_speed_call, s.oi_call),
    put: legRisk(s.iv_put_1h, s.de_put, s.delta_speed_put, s.gamma_speed_put, s.oi_put),
    futLong: dir(up),
    futShort: dir(dn),
  };
}

/** Recency-weighted lines at grid time t. `cohorts` need not have option legs (a futures-only cohort has null leg inputs). */
export function linesAt(t: number, cohorts: readonly CohortSteps[]): Lines {
  const eligible = cohorts.filter((c) => c.opened_at <= t).sort((a, b) => b.opened_at - a.opened_at);
  const fresh = eligible.flatMap((c) => {
    const step = [...c.steps].reverse().find((x) => x.sampled_ms <= t);
    return step && t - step.sampled_ms <= SCORE_CONFIG.staleStepMs ? [stepLines(step)] : [];
  });
  const out: Lines = { call: null, put: null, futLong: null, futShort: null };
  for (const k of Object.keys(out) as (keyof Lines)[]) {
    let acc = 0;
    let w = 0;
    let prev = 0;
    for (const g of SCORE_CONFIG.recency) {
      const vals = fresh.slice(prev, g.upTo).map((l) => l[k]).filter(ok);
      prev = g.upTo;
      if (vals.length === 0) continue;
      acc += g.weight * (vals.reduce((a, b) => a + b, 0) / vals.length);
      w += g.weight;
    }
    out[k] = w === 0 ? null : Math.round((acc / w) * 10) / 10;
  }
  return out;
}
