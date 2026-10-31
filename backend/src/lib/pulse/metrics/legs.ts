/** Leg metrics for Strangle Pulse. Pure; a missing input or a zero divisor gives null. */
import { METRIC_CONFIG } from '../config.js';

type N = number | null;

const ok = (v: N): v is number => v !== null && Number.isFinite(v);

/** Delta shift index: call delta change minus put delta change; null when spot barely moved. */
export function dsi(dCallDelta: N, dPutDelta: N, spotPrev: N, spotNow: N): N {
  if (!ok(dCallDelta) || !ok(dPutDelta) || !ok(spotPrev) || !ok(spotNow) || spotPrev <= 0) return null;
  const movePct = (Math.abs(spotNow - spotPrev) / spotPrev) * 100;
  if (movePct < METRIC_CONFIG.minMovePct) return null;
  return dCallDelta - dPutDelta;
}

export type OiSignal = 'short_buildup' | 'long_unwinding' | 'long_buildup' | 'short_covering' | 'unconfirmed' | null;

/** Premium and OI direction read as a positioning signal; unconfirmed without rising volume. */
export function oiSignal(premiumChange: N, oiChange: N, volumeChange: N): OiSignal {
  if (!ok(premiumChange) || !ok(oiChange) || premiumChange === 0 || oiChange === 0) return null;
  if (METRIC_CONFIG.volumeConfirmsOi && !(ok(volumeChange) && volumeChange > 0)) return 'unconfirmed';
  if (premiumChange < 0) return oiChange > 0 ? 'short_buildup' : 'long_unwinding';
  return oiChange > 0 ? 'long_buildup' : 'short_covering';
}

/** Bid-ask spread as a fraction of mid. */
export function spreadPct(bid: N, ask: N, mid: N): N {
  if (!ok(bid) || !ok(ask) || !ok(mid) || mid <= 0) return null;
  return (ask - bid) / mid;
}

/** Cost above fair value to buy both legs back at ask, as a fraction of the entry premium (call bid + put bid). */
export function exitCostPct(callAsk: N, putAsk: N, callMid: N, putMid: N, callBid: N, putBid: N): N {
  if (!ok(callAsk) || !ok(putAsk) || !ok(callMid) || !ok(putMid) || !ok(callBid) || !ok(putBid)) return null;
  const credit = callBid + putBid;
  if (credit <= 0) return null;
  return (callAsk - callMid + (putAsk - putMid)) / credit;
}

/** Median of a list, or null when empty. */
export function median(values: readonly number[]): N {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Exit-cost band: below 0.05 normal, 0.05 to 0.10 penalty, above 0.10 veto. */
export function liquidityBand(exitCost: N): 'normal' | 'penalty' | 'veto' | null {
  if (!ok(exitCost)) return null;
  if (exitCost < 0.05) return 'normal';
  return exitCost <= 0.1 ? 'penalty' : 'veto';
}

/** True when the spread is above 0.10 or above twice its 24h median. A null spread is false (NO DATA handles it). */
export function spreadVeto(spread: N, median24h: N): boolean {
  if (!ok(spread)) return false;
  return spread > 0.1 || (ok(median24h) && spread > 2 * median24h);
}
