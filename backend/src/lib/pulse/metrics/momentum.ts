/**
 * RSI and ADX-style momentum for the Short Strangle lane. Display only: nothing here feeds the verdict, because it has not been backtested.
 * Pure; a value that cannot be computed yet is null.
 *
 * Both take a list of step changes, not levels. The strikes roll every hour, so a level series would jump at each roll and read as a
 * move that never happened. Changes are measured inside one contract, then joined.
 * The ADX is the close-only form (+DM and -DM from the change, true range = its size), since these series have no high or low.
 */
import { PULSE_CONFIG } from '../config.js';

type N = number | null;

export const MOMENTUM_PERIOD = 14;
const GRID_MS = PULSE_CONFIG.snapshotMinutes * 60_000;
/** A step further apart than this is an outage, and its change would stand for far more than one step. */
const MAX_STEP_MS = 3 * GRID_MS;
/** ±DI closer than this is treated as no direction. */
const FLAT_DI = 5;

export interface Momentum {
  rsi: N;
  adx: N;
  direction: 'up' | 'down' | 'flat' | null;
  samples: number;
  /** Changes needed before the RSI appears; the ADX needs twice this period. */
  needed: number;
}

export type Greek = 'delta' | 'gamma' | 'theta' | 'vega';
type LegGreeks = Record<Greek, N>;

export interface MomentumRow {
  grid_ms: number;
  sampled_ms: number;
  fut_price: number;
  data_ok: boolean;
  call: LegGreeks;
  put: LegGreeks;
}

export interface MomentumCohort { opened_at: number; rows: readonly MomentumRow[] }

const round1 = (x: number) => Math.round(x * 10) / 10;
/** Wilder's running average: the seed is the plain mean of the first `period` values. */
const wilderNext = (prev: number, x: number, period: number) => (prev * (period - 1) + x) / period;
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function rsiOf(changes: readonly number[], period: number): N {
  if (changes.length < period) return null;
  let gain = mean(changes.slice(0, period).map((c) => Math.max(c, 0)));
  let loss = mean(changes.slice(0, period).map((c) => Math.max(-c, 0)));
  for (const c of changes.slice(period)) {
    gain = wilderNext(gain, Math.max(c, 0), period);
    loss = wilderNext(loss, Math.max(-c, 0), period);
  }
  if (gain === 0 && loss === 0) return 50;
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

function trendOf(changes: readonly number[], period: number): { adx: N; plus: number; minus: number } {
  if (changes.length < period) return { adx: null, plus: 0, minus: 0 };
  let up = mean(changes.slice(0, period).map((c) => Math.max(c, 0)));
  let down = mean(changes.slice(0, period).map((c) => Math.max(-c, 0)));
  const di = () => (up + down === 0 ? { plus: 0, minus: 0, dx: 0 } : { plus: (100 * up) / (up + down), minus: (100 * down) / (up + down), dx: (100 * Math.abs(up - down)) / (up + down) });
  const dx = [di().dx];
  for (const c of changes.slice(period)) {
    up = wilderNext(up, Math.max(c, 0), period);
    down = wilderNext(down, Math.max(-c, 0), period);
    dx.push(di().dx);
  }
  const { plus, minus } = di();
  if (dx.length < period) return { adx: null, plus, minus };
  let adx = mean(dx.slice(0, period));
  for (const x of dx.slice(period)) adx = wilderNext(adx, x, period);
  return { adx, plus, minus };
}

export function momentum(changes: readonly number[], period = MOMENTUM_PERIOD): Momentum {
  const rsi = rsiOf(changes, period);
  const { adx, plus, minus } = trendOf(changes, period);
  const direction = rsi === null ? null : Math.abs(plus - minus) < FLAT_DI ? 'flat' : plus > minus ? 'up' : 'down';
  return { rsi: rsi === null ? null : round1(rsi), adx: adx === null ? null : round1(adx), direction, samples: changes.length, needed: period + 1 };
}

const goodRows = (c: MomentumCohort) => c.rows.filter((r) => r.data_ok);

/** Relative change in a leg's greek between neighbouring rows of one contract. Size only, so a put delta going more negative is rising. */
export function greekChanges(cohorts: readonly MomentumCohort[], leg: 'call' | 'put', greek: Greek): number[] {
  const byGrid = new Map<number, { opened: number; change: number }>();
  for (const c of cohorts) {
    const rows = goodRows(c);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const was = a[leg][greek], now = b[leg][greek];
      if (was === null || now === null || was === 0 || b.sampled_ms - a.sampled_ms > MAX_STEP_MS) continue;
      const held = byGrid.get(b.grid_ms);
      if (!held || c.opened_at > held.opened) byGrid.set(b.grid_ms, { opened: c.opened_at, change: (Math.abs(now) - Math.abs(was)) / Math.abs(was) });
    }
  }
  return [...byGrid.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v.change);
}

/** Percent change in the futures price, one per grid. The price is the same market in every cohort, so this joins them directly. */
export function priceChanges(cohorts: readonly MomentumCohort[]): number[] {
  const byGrid = new Map<number, number>();
  for (const c of cohorts) for (const r of goodRows(c)) if (r.fut_price > 0) byGrid.set(r.grid_ms, r.fut_price);
  const points = [...byGrid.entries()].sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] - points[i - 1][0] > MAX_STEP_MS) continue;
    out.push((100 * (points[i][1] - points[i - 1][1])) / points[i - 1][1]);
  }
  return out;
}

/** Step changes of a 0-100 line, joining across missing values. */
export function seriesChanges(values: readonly N[]): number[] {
  const known = values.filter((v): v is number => v !== null);
  return known.slice(1).map((v, i) => v - known[i]);
}

/** Every reading the lane shows. A futures position has no gamma, theta or vega, so it reads the line and the price. */
export function pulseMomentum(cohorts: readonly MomentumCohort[], lines: { call: readonly N[]; put: readonly N[]; futLong: readonly N[]; futShort: readonly N[] }) {
  const leg = (name: 'call' | 'put') => ({
    line: momentum(seriesChanges(lines[name])),
    delta: momentum(greekChanges(cohorts, name, 'delta')),
    gamma: momentum(greekChanges(cohorts, name, 'gamma')),
    theta: momentum(greekChanges(cohorts, name, 'theta')),
    vega: momentum(greekChanges(cohorts, name, 'vega')),
  });
  const price = priceChanges(cohorts);
  return {
    period: MOMENTUM_PERIOD,
    call: leg('call'),
    put: leg('put'),
    futLong: { line: momentum(seriesChanges(lines.futLong)), price: momentum(price) },
    futShort: { line: momentum(seriesChanges(lines.futShort)), price: momentum(price.map((x) => -x)) },
  };
}
