/**
 * IV-crush signals used by Step 2, using the EXACT backend definitions:
 *  - Speed vs IV  = RV(1h annualized) / ATM IV      (calm if < 1.5)
 *  - IV vs Clock  = IV(now) < IV(17:30 listing)     (premium decaying below reference)
 *  - VoV (smooth) = IV falling over 1h AND |IV_now - IV_3hAgo| < 1.5  (genuine crush,
 *                   per stage6_indicator_audit.ts: smooth decline vs spike)
 */
import type { Bar } from '../data/load.js';

/** 1-minute realized vol, annualized to % (matches stage1 rvOver semantics, ×525600). */
export function rvAnnualizedPct(bars: Bar[]): number | null {
  const r: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].c > 0 && bars[i - 1].c > 0) r.push(Math.log(bars[i].c / bars[i - 1].c));
  }
  if (r.length < 10) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const s2 = r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1);
  return Math.sqrt(s2 * 525600) * 100;
}

export interface CrushLabel {
  hasEvent: boolean; // a clear NY spike-then-fall occurred
  peakIv: number;
  peakT: number;
  troughIv: number;
  troughT: number;
  fellPts: number; // peak - trough
  reRise: boolean; // IV rose back >= RERISE above trough before exit
  label: 'CRUSH' | 'REBOUND' | 'NO-EVENT';
}

const MIN_FALL = 2.0; // pts peak->trough to count as a spike-then-fall
const RERISE = 2.0; // pts back above trough = real fear rebound

/**
 * Classify the night's post-NY-open IV path. GENUINE CRUSH (sellable) = fell and did
 * NOT re-rise. REBOUND (real fear) = fell then rose back. Forward-looking — for LABELING
 * only, never used as an entry signal.
 */
export function classifyCrush(
  ivSeries: [number, number][],
  openT: number,
  peakWindowEndT: number,
  exitT: number,
): CrushLabel {
  const inWin = ivSeries.filter(([t]) => t >= openT && t <= exitT);
  if (inWin.length < 3) {
    return { hasEvent: false, peakIv: 0, peakT: 0, troughIv: 0, troughT: 0, fellPts: 0, reRise: false, label: 'NO-EVENT' };
  }
  // Peak within the NY fear window.
  let peakIv = -Infinity, peakT = openT;
  for (const [t, iv] of inWin) {
    if (t <= peakWindowEndT && iv > peakIv) { peakIv = iv; peakT = t; }
  }
  // Trough after the peak.
  let troughIv = Infinity, troughT = peakT;
  for (const [t, iv] of inWin) {
    if (t > peakT && iv < troughIv) { troughIv = iv; troughT = t; }
  }
  if (!Number.isFinite(peakIv) || !Number.isFinite(troughIv)) {
    return { hasEvent: false, peakIv: 0, peakT, troughIv: 0, troughT, fellPts: 0, reRise: false, label: 'NO-EVENT' };
  }
  const fellPts = peakIv - troughIv;
  if (fellPts < MIN_FALL) {
    return { hasEvent: false, peakIv, peakT, troughIv, troughT, fellPts, reRise: false, label: 'NO-EVENT' };
  }
  // Re-rise after the trough?
  let reRise = false;
  for (const [t, iv] of inWin) {
    if (t > troughT && iv >= troughIv + RERISE) { reRise = true; break; }
  }
  return { hasEvent: true, peakIv, peakT, troughIv, troughT, fellPts, reRise, label: reRise ? 'REBOUND' : 'CRUSH' };
}

/** First 15m time after the peak where IV has fallen >= fallTrig pts (crush begins). */
export function crushEntryTrigger(
  ivAt: (t: number) => number | null,
  peakIv: number,
  peakT: number,
  windowEndT: number,
  fallTrig = 1.5,
  stepMs = 15 * 60_000,
): number | null {
  for (let t = Math.ceil(peakT / stepMs) * stepMs; t <= windowEndT; t += stepMs) {
    const iv = ivAt(t);
    if (iv != null && peakIv - iv >= fallTrig) return t;
  }
  return null;
}
