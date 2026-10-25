import type { StrategyId } from './types.js';

const MIN = 60_000;
const HR = 3_600_000;
const DAY = 86_400_000;
/** IST is UTC+5:30 with no daylight saving, so a fixed offset is exact. */
export const IST_OFFSET_MS = 19_800_000;

interface Slot {
  /** Entry time of day, IST, minutes after midnight. */
  entryMin: number;
  /** Time exit, minutes after the entry day's IST midnight (can exceed 1440 for next-day exits). */
  exitMin: number;
}

/**
 * Entry and forced-exit clock per strategy (IST).
 * CAL_BACK is signal-driven (backwardation), so it has no fixed slot.
 */
export const SLOTS: Record<Exclude<StrategyId, 'CAL_BACK'>, Slot> = {
  ASIA_SHORT: { entryMin: 10 * 60, exitMin: 16 * 60 },
  NY_SHORT: { entryMin: 22 * 60 + 30, exitMin: 24 * 60 + 7 * 60 },
  EVE_LONG: { entryMin: 17 * 60 + 30, exitMin: 21 * 60 },
  PRE_LONG: { entryMin: 5 * 60, exitMin: 9 * 60 },
  // Iron condors run a full 24h, no intraday time exit.
  ASIA_IC: { entryMin: 10 * 60, exitMin: 24 * 60 + 10 * 60 },
  NY_IC: { entryMin: 22 * 60 + 30, exitMin: 24 * 60 + 22 * 60 + 30 },
};

export function hasFixedSlot(id: StrategyId): id is Exclude<StrategyId, 'CAL_BACK'> {
  return id !== 'CAL_BACK';
}

/** IST calendar date key (YYYY-MM-DD) for an epoch ms instant. */
export function istDateKey(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of IST midnight that starts the given IST date key. */
export function istMidnightMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00Z`) - IST_OFFSET_MS;
}

export interface RunWindow {
  entryAtMs: number;
  exitAtMs: number;
}

export function runWindow(id: Exclude<StrategyId, 'CAL_BACK'>, dateKey: string): RunWindow {
  const s = SLOTS[id];
  const base = istMidnightMs(dateKey);
  return { entryAtMs: base + s.entryMin * MIN, exitAtMs: base + s.exitMin * MIN };
}

/**
 * Entries that are due now: the IST date's entry time has passed, but not by more than
 * `graceMs`, so a late restart still enters within a short window but never chases a
 * stale setup hours later.
 */
export function dueEntries(
  nowMs: number,
  graceMs = 10 * MIN,
): Array<{ id: Exclude<StrategyId, 'CAL_BACK'>; dateKey: string; window: RunWindow }> {
  const out: Array<{ id: Exclude<StrategyId, 'CAL_BACK'>; dateKey: string; window: RunWindow }> = [];
  const today = istDateKey(nowMs);
  const yesterday = istDateKey(nowMs - DAY);
  for (const id of Object.keys(SLOTS) as Array<Exclude<StrategyId, 'CAL_BACK'>>) {
    for (const dateKey of [today, yesterday]) {
      const w = runWindow(id, dateKey);
      if (nowMs >= w.entryAtMs && nowMs < w.entryAtMs + graceMs) out.push({ id, dateKey, window: w });
    }
  }
  return out;
}

/** Idempotency key: one run per strategy, IST date and book. */
export function runKey(id: StrategyId, dateKey: string, book: 'always' | 'gated'): string {
  return `${id}:${dateKey}:${book}`;
}

/** Floor an instant to the minute boundary. */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / MIN) * MIN;
}

export { MIN, HR, DAY };
