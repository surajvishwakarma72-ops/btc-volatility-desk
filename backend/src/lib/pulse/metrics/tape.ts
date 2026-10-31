/** Futures probe and session baseline for Strangle Pulse. Pure; a missing input or a zero divisor gives null. */
import { METRIC_CONFIG } from '../config.js';
import { median } from './legs.js';

type N = number | null;
type Side = 'long' | 'short';

const ok = (v: N): v is number => v !== null && Number.isFinite(v);

/** Which hedge side is ahead; null on a tie or a missing P&L. */
export function winnerSide(longPnl: N, shortPnl: N): Side | null {
  if (!ok(longPnl) || !ok(shortPnl) || longPnl === shortPnl) return null;
  return longPnl > shortPnl ? 'long' : 'short';
}

/** Side that won most of the newest 6 samples (newest first); null on an empty window or a tied count. */
export function winnerPersistence(winners: readonly (Side | null)[]): { side: Side; count: number } | null {
  const recent = winners.slice(0, 6);
  const long = recent.filter((w) => w === 'long').length;
  const short = recent.filter((w) => w === 'short').length;
  if (long === short) return null;
  return long > short ? { side: 'long', count: long } : { side: 'short', count: short };
}

/** Breakeven prices of a short strangle for the credit collected (call bid + put bid). */
export function breakevens(callStrike: N, putStrike: N, credit: N): { up: number; down: number } | null {
  if (!ok(callStrike) || !ok(putStrike) || !ok(credit)) return null;
  return { up: callStrike + credit, down: putStrike - credit };
}

/** Largest futures move from entry, as a share of the nearer breakeven distance. */
export function moveVsBreakeven(spotEntry: N, futPrices: readonly number[], futEntry: N, be: { up: number; down: number } | null): N {
  if (!ok(spotEntry) || !ok(futEntry) || !be || futPrices.length === 0) return null;
  const room = Math.min(be.up - spotEntry, spotEntry - be.down);
  if (room <= 0) return null;
  return Math.max(...futPrices.map((p) => Math.abs(p - futEntry))) / room;
}

/** Net move over total path length: 1 is a straight line, near 0 is chop. */
export function efficiencyRatio(prices: readonly number[]): N {
  if (prices.length < 2) return null;
  let path = 0;
  for (let i = 1; i < prices.length; i++) path += Math.abs(prices[i] - prices[i - 1]);
  if (path <= 0) return null;
  return Math.abs(prices[prices.length - 1] - prices[0]) / path;
}

/** Current value against the median of same-session history; null without enough samples or a positive median. */
export function sessionBaseline(history: readonly number[], current: N): { median: number; ratio: number } | null {
  if (history.length < METRIC_CONFIG.sessionMinSamples || !ok(current)) return null;
  const m = median(history);
  if (m === null || m <= 0) return null;
  return { median: m, ratio: current / m };
}
