/**
 * Server-side port of the desk's regime indicators (frontend/index.html: returnsOf, rvWindow, dailyRv, dPercentile,
 * adxSeries, regimeCompute). Pure functions on plain arrays; behaviour must stay identical to the browser.
 */
import { REGIME_CONFIG as C } from '../config.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** One hourly index bar. `t` is the bar-open epoch ms. */
export interface Bar1h {
  t: number;
  o?: number;
  h: number;
  l: number;
  c: number;
}

/** Log return ending at bar `t`; `h` is the real span of the return in hours. */
export interface HourReturn {
  t: number;
  r: number;
  h: number;
}

export interface RegimeState {
  adx: number | null;
  adxPrev: number | null;
  adxUp: boolean;
  rvp: number | null;
  rvpPrev: number | null;
  rvpUp: boolean;
  killer: boolean | null;
  rv7: number | null;
}

const mean = (a: readonly number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * Close-to-close log returns, each with the hours it really spans (gaps widen it). When `nowMs` is given, the bar still
 * forming at that moment is weighted by the part elapsed, as the browser does.
 */
export function hourReturns(bars: readonly Bar1h[], nowMs?: number): HourReturn[] {
  const out: HourReturn[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1]!;
    const b = bars[i]!;
    if (!(a.c > 0 && b.c > 0)) continue;
    let span = b.t - a.t;
    if (nowMs !== undefined && b.t + HOUR_MS > nowMs) span = Math.max(1000, span - (b.t + HOUR_MS - nowMs));
    out.push({ t: b.t, r: Math.log(b.c / a.c), h: span / HOUR_MS });
  }
  return out;
}

/** Annualised realised vol (decimal) over the `hours` ending at `endT`; null when under the coverage minimum. */
export function rvWindow(rets: readonly HourReturn[], endT: number, hours: number): number | null {
  let s = 0;
  let h = 0;
  for (let i = rets.length - 1; i >= 0 && rets[i]!.t > endT - hours * HOUR_MS; i--) {
    if (rets[i]!.t <= endT) {
      s += rets[i]!.r * rets[i]!.r;
      h += rets[i]!.h;
    }
  }
  return h >= hours * C.rvCoverageMin ? Math.sqrt((s * C.hoursPerYear) / h) : null;
}

/** Realised vol per completed UTC day with enough hours covered. */
export function dailyRv(rets: readonly HourReturn[], nowMs: number): Array<{ day: number; t: number; v: number }> {
  const m = new Map<number, { s: number; h: number }>();
  for (const x of rets) {
    const d = Math.floor(x.t / DAY_MS);
    const b = m.get(d) ?? { s: 0, h: 0 };
    b.s += x.r * x.r;
    b.h += x.h;
    m.set(d, b);
  }
  const today = Math.floor(nowMs / DAY_MS);
  return [...m.entries()]
    .filter(([d, b]) => d < today && b.h >= C.minDaysHours)
    .sort((a, b) => a[0] - b[0])
    .map(([d, b]) => ({ day: d, t: d * DAY_MS, v: Math.sqrt((b.s * C.hoursPerYear) / b.h) }));
}

/** Fraction of `arr` strictly below `v`. */
export function percentileBelow(arr: readonly number[], v: number | null): number | null {
  if (!arr.length || v == null) return null;
  let n = 0;
  for (const x of arr) if (x < v) n++;
  return n / arr.length;
}

/** Wilder ADX; null when fewer than 3 periods of bars. */
export function adxSeries(bars: readonly Bar1h[], n: number = C.adxPeriod): Array<{ t: number; v: number }> | null {
  if (!bars || bars.length < n * 3) return null;
  let tr = 0;
  let pdm = 0;
  let ndm = 0;
  let adx: number | null = null;
  const dxs: number[] = [];
  const out: Array<{ t: number; v: number }> = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1]!;
    const b = bars[i]!;
    const up = b.h - a.h;
    const dn = a.l - b.l;
    const p = up > dn && up > 0 ? up : 0;
    const m = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(b.h - b.l, Math.abs(b.h - a.c), Math.abs(b.l - a.c));
    if (i <= n) {
      tr += t;
      pdm += p;
      ndm += m;
      if (i < n) continue;
    } else {
      tr = tr - tr / n + t;
      pdm = pdm - pdm / n + p;
      ndm = ndm - ndm / n + m;
    }
    const pdi = tr > 0 ? (100 * pdm) / tr : 0;
    const ndi = tr > 0 ? (100 * ndm) / tr : 0;
    const dx = pdi + ndi > 0 ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0;
    if (adx == null) {
      dxs.push(dx);
      if (dxs.length < n) continue;
      adx = mean(dxs)!;
    } else {
      adx = (adx * (n - 1) + dx) / n;
    }
    out.push({ t: b.t, v: adx });
  }
  return out;
}

/** Regime reading at `nowMs`: ADX and realised-vol percentile with their one-step-ago values and the killer flag. */
export function regimeState(bars: readonly Bar1h[], nowMs: number): RegimeState | null {
  const rets = hourReturns(bars, nowMs);
  const days = dailyRv(rets, nowMs);
  if (days.length < C.rvpMinDays || !rets.length) return null;
  const endT = rets[rets.length - 1]!.t;
  const rv7 = rvWindow(rets, endT, C.rvWindowHours);
  if (rv7 == null) return null;

  const d = days.slice(-C.rvpDays);
  const s7: number[] = [];
  for (let i = C.rvpWindowDays - 1; i < d.length; i++) {
    s7.push(Math.sqrt(mean(d.slice(i - (C.rvpWindowDays - 1), i + 1).map((x) => x.v * x.v))!));
  }
  const rvPrev = rvWindow(rets, endT - DAY_MS, C.rvWindowHours);
  const rvp = percentileBelow(s7, rv7);
  const rvpPrev = rvPrev != null ? percentileBelow(s7, rvPrev) : null;

  const A = adxSeries(bars.slice(-C.adxBars));
  const adx = A && A.length ? A[A.length - 1]!.v : null;
  const adxPrev = A && A.length > C.adxLookbackBars ? A[A.length - 1 - C.adxLookbackBars]!.v : null;

  const rvpUp = rvp != null && rvpPrev != null && rvp - rvpPrev >= C.rvpRiseMin;
  const adxUp = adx != null && adxPrev != null && adx - adxPrev >= C.adxRiseMin;
  const known = rvp != null && rvpPrev != null && adx != null && adxPrev != null;
  return { adx, adxPrev, adxUp, rvp, rvpPrev, rvpUp, killer: known ? rvpUp && adxUp : null, rv7 };
}

/** Implied over realised vol (both decimals); null when either is missing or RV is not positive. */
export function ivOverRv(ivDecimal: number | null, rvDecimal: number | null): number | null {
  if (ivDecimal == null || rvDecimal == null || !(rvDecimal > 0)) return null;
  return ivDecimal / rvDecimal;
}
