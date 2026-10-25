import { CAL_ENTRY_MIN_IST } from './calendar.js';
import { CAL_WAIT_MS, DAY, MIN, SLOTS, entryWindowMs, istDateKey, istMidnightMs, runWindow } from './schedule.js';
import type { StrategyId } from './types.js';

/**
 * "Today" on the Bot page: every scheduled strategy slot for the current IST day (plus yesterday's overnight one if it is
 * still running), with where it stands. Pure: the route reads the rows and the engine's waiting list.
 */
export type SlotState = 'upcoming' | 'waiting' | 'open' | 'closed' | 'dropped' | 'missed';

export interface SlotRun {
  id?: string;
  book: string;
  status: string;
  tags?: { reason?: string; blocked?: string[]; enteredAfterWaitMin?: number; attempts?: number } | null;
  netPnl: number | null;
  grossPnl: number | null;
  fees: number | null;
  entryAtMs: number | null;
  exitAtMs: number | null;
  plannedExitAtMs: number | null;
  exitReason: string | null;
  exitDetail: string | null;
  marginUsd: number | null;
}

export interface WaitInfo {
  key: string;
  attempts: number;
  lastReason: string | null;
  windowEndMs: number;
}

export interface TimelineSlot {
  id: StrategyId;
  dateKey: string;
  entryAtMs: number;
  windowEndMs: number;
  plannedExitAtMs: number | null;
  state: SlotState;
  /** Why it is waiting, or why it did not trade. */
  reason: string | null;
  run: SlotRun | null;
  /** The gated book's run for the same slot, when the strangle has one. */
  gated: SlotRun | null;
  /** Open now: the live net PnL, supplied by the caller from the running position. */
}

const ids = (): Array<Exclude<StrategyId, 'CAL_BACK'>> => Object.keys(SLOTS) as Array<Exclude<StrategyId, 'CAL_BACK'>>;

export function buildTimeline(nowMs: number, runs: ReadonlyMap<string, SlotRun>, waiting: readonly WaitInfo[]): TimelineSlot[] {
  const out: TimelineSlot[] = [];
  const dates = [istDateKey(nowMs - DAY), istDateKey(nowMs)];
  for (const dateKey of dates) {
    const consider: Array<{ id: StrategyId; entryAtMs: number; windowEndMs: number; plannedExitAtMs: number | null }> = [];
    for (const id of ids()) {
      const w = runWindow(id, dateKey);
      consider.push({ id, entryAtMs: w.entryAtMs, windowEndMs: w.entryAtMs + entryWindowMs(id), plannedExitAtMs: w.exitAtMs });
    }
    const calEntry = istMidnightMs(dateKey) + CAL_ENTRY_MIN_IST * MIN;
    consider.push({ id: 'CAL_BACK', entryAtMs: calEntry, windowEndMs: calEntry + CAL_WAIT_MS, plannedExitAtMs: null });
    for (const c of consider) {
      const run = runs.get(`${c.id}:${dateKey}:always`) ?? null;
      const gated = runs.get(`${c.id}:${dateKey}:gated`) ?? null;
      // yesterday's slots only matter while they are still live (overnight strangle, a position still open)
      const live = run?.status === 'open' || (c.plannedExitAtMs != null && nowMs < c.plannedExitAtMs && run != null) || nowMs < c.windowEndMs;
      if (dateKey !== dates[1] && !live) continue;
      const wait = waiting.find((x) => x.key === `${c.id}:${dateKey}:always`) ?? waiting.find((x) => x.key === `${c.id}:${dateKey}:gated`);
      let state: SlotState;
      let reason: string | null = null;
      if (run && run.status === 'open') state = 'open';
      else if (run && run.status === 'closed') state = 'closed';
      else if (run && (run.status === 'skipped' || run.status === 'failed')) {
        state = 'dropped';
        reason = run.tags?.reason ?? (run.tags?.blocked ? `risk guard blocked: ${run.tags.blocked.join('; ')}` : 'no reason recorded');
      } else if (nowMs < c.entryAtMs) state = 'upcoming';
      else if (nowMs < c.windowEndMs) {
        state = 'waiting';
        reason = wait?.lastReason ?? 'checking the market';
      } else {
        state = 'missed';
        reason = 'no trade was recorded for this slot (the bot was off or restarting, or no data came in)';
      }
      out.push({ id: c.id, dateKey, entryAtMs: c.entryAtMs, windowEndMs: c.windowEndMs, plannedExitAtMs: run?.plannedExitAtMs ?? c.plannedExitAtMs, state, reason, run, gated });
    }
  }
  return out.sort((a, b) => a.entryAtMs - b.entryAtMs);
}
