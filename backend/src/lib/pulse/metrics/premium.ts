/** Premium metrics for Strangle Pulse. Pure; a missing input or a zero divisor gives null. */
import { METRIC_CONFIG } from '../config.js';

type N = number | null;

const ok = (v: N): v is number => v !== null && Number.isFinite(v);

/** Share of the theta-expected decay actually captured: (entry - now) / (|theta| x days). */
export function decayEfficiency(entryMid: N, nowMid: N, thetaEntry: N, elapsedDays: number): N {
  if (!ok(entryMid) || !ok(nowMid) || !ok(thetaEntry) || !Number.isFinite(elapsedDays)) return null;
  const expected = Math.abs(thetaEntry) * elapsedDays;
  if (expected <= 0) return null;
  return (entryMid - nowMid) / expected;
}

/** Size of the shift in call/put premium balance since entry: |ln(C_now/P_now) - ln(C_entry/P_entry)|. heavyLeg carries direction. */
export function balanceDrift(cEntry: N, pEntry: N, cNow: N, pNow: N): N {
  if (!ok(cEntry) || !ok(pEntry) || !ok(cNow) || !ok(pNow)) return null;
  if (cEntry <= 0 || pEntry <= 0 || cNow <= 0 || pNow <= 0) return null;
  return Math.abs(Math.log(cNow / pNow) - Math.log(cEntry / pEntry));
}

/** The leg whose premium grew more, when the now/entry ratios differ by at least heavyLegGap. */
export function heavyLeg(cEntry: N, pEntry: N, cNow: N, pNow: N): 'call' | 'put' | null {
  if (!ok(cEntry) || !ok(pEntry) || !ok(cNow) || !ok(pNow)) return null;
  if (cEntry <= 0 || pEntry <= 0) return null;
  const gap = cNow / cEntry - pNow / pEntry;
  // Tolerance so a gap of exactly heavyLegGap is not lost to float error.
  if (Math.abs(gap) < METRIC_CONFIG.heavyLegGap - 1e-12) return null;
  return gap > 0 ? 'call' : 'put';
}

/** Change in iv, in vol points. */
export function ivChange(now: N, base: N): N {
  if (!ok(now) || !ok(base)) return null;
  return now - base;
}

/** One-sigma USD move over elapsedDays: spot x iv/100 x sqrt(days/365). iv is in vol points. */
export function expectedMove(spot: N, ivPoints: N, elapsedDays: number): N {
  if (!ok(spot) || !ok(ivPoints) || !Number.isFinite(elapsedDays)) return null;
  if (spot <= 0 || ivPoints <= 0 || elapsedDays <= 0) return null;
  return spot * (ivPoints / 100) * Math.sqrt(elapsedDays / 365);
}

/** Realised spot range over the expected move: (max - min) / expected. */
export function rangeRatio(spots: readonly number[], expected: N): N {
  const s = spots.filter(Number.isFinite);
  if (s.length === 0 || !ok(expected) || expected <= 0) return null;
  return (Math.max(...s) - Math.min(...s)) / expected;
}
