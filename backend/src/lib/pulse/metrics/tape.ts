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

/**
 * Side that won most of the judged cohorts (newest first, at most persistenceWindow), with n = how many were judged.
 * Null below persistenceMinCohorts or on a tied count. A trend veto must read count against n: 5 of 6 needs n = 6.
 */
export function winnerPersistence(winners: readonly (Side | null)[]): { side: Side; count: number; n: number } | null {
  const recent = winners.slice(0, METRIC_CONFIG.persistenceWindow);
  const n = recent.length;
  if (n < METRIC_CONFIG.persistenceMinCohorts) return null;
  const long = recent.filter((w) => w === 'long').length;
  const short = recent.filter((w) => w === 'short').length;
  if (long === short) return null;
  return long > short ? { side: 'long', count: long, n } : { side: 'short', count: short, n };
}

/** Breakeven prices of a short strangle for the credit collected (call bid + put bid). */
export function breakevens(callStrike: N, putStrike: N, credit: N): { up: number; down: number } | null {
  if (!ok(callStrike) || !ok(putStrike) || !ok(credit)) return null;
  return { up: callStrike + credit, down: putStrike - credit };
}

/** Largest futures move from entry, as a share of the nearer breakeven distance. */
export function moveVsBreakeven(spotEntry: N, futPrices: readonly number[], futEntry: N, be: { up: number; down: number } | null): N {
  const fut = futPrices.filter(Number.isFinite);
  if (!ok(spotEntry) || !ok(futEntry) || !be || fut.length === 0) return null;
  const room = Math.min(be.up - spotEntry, spotEntry - be.down);
  if (room <= 0) return null;
  return Math.max(...fut.map((p) => Math.abs(p - futEntry))) / room;
}

/** Net move over total path length: 1 is a straight line, near 0 is chop. */
export function efficiencyRatio(all: readonly number[]): N {
  const prices = all.filter(Number.isFinite);
  if (prices.length < 2) return null;
  let path = 0;
  for (let i = 1; i < prices.length; i++) path += Math.abs(prices[i] - prices[i - 1]);
  if (path <= 0) return null;
  return Math.abs(prices[prices.length - 1] - prices[0]) / path;
}

/** Current value against the median of same-session history; null without enough samples or a positive median. */
export function sessionBaseline(history: readonly number[], current: N): { median: number; ratio: number } | null {
  const h = history.filter(Number.isFinite);
  if (h.length < METRIC_CONFIG.sessionMinSamples || !ok(current)) return null;
  const m = median(h);
  if (m === null || m <= 0) return null;
  return { median: m, ratio: current / m };
}
