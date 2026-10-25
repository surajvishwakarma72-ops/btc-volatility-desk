import { describe, expect, it } from 'vitest';
import { buildTimeline, type SlotRun, type WaitInfo } from './timeline.js';
import { istMidnightMs } from './schedule.js';

const day = '2026-10-26';
const at = (h: number, m = 0, d = day) => istMidnightMs(d) + (h * 60 + m) * 60_000;
const run = (over: Partial<SlotRun> = {}): SlotRun => ({
  book: 'always', status: 'open', tags: null, netPnl: null, grossPnl: null, fees: null, entryAtMs: null, exitAtMs: null, plannedExitAtMs: null,
  exitReason: null, exitDetail: null, marginUsd: null, ...over,
});
const find = (t: ReturnType<typeof buildTimeline>, id: string, d = day) => t.find((s) => s.id === id && s.dateKey === d)!;

describe('today timeline', () => {
  it('lists every slot of the day in time order, upcoming before its time', () => {
    const t = buildTimeline(at(8), new Map(), []);
    const today = t.filter((s) => s.dateKey === day);
    expect(today.map((s) => s.id)).toEqual(['PRE_LONG', 'ASIA_SHORT', 'EVE_LONG', 'CAL_BACK', 'NY_SHORT']);
    expect(today.find((s) => s.id === 'PRE_LONG')!.state).toBe('missed'); // 05:00 and its 30 minute window are over with nothing recorded
    expect(today.find((s) => s.id === 'ASIA_SHORT')!.state).toBe('upcoming');
    expect(find(t, 'NY_SHORT').entryAtMs).toBe(at(22, 30));
  });

  it('shows waiting with the reason right now, then dropped with the final reason', () => {
    const waiting: WaitInfo[] = [{ key: `ASIA_SHORT:${day}:always`, attempts: 12, lastReason: 'no tradable strikes', windowEndMs: at(12) }];
    expect(find(buildTimeline(at(10, 20), new Map(), waiting), 'ASIA_SHORT')).toMatchObject({ state: 'waiting', reason: 'no tradable strikes' });
    const dropped = new Map([[`ASIA_SHORT:${day}:always`, run({ status: 'skipped', tags: { reason: 'gate WAIT (DVOL 70 >= 65)' } })]]);
    expect(find(buildTimeline(at(12, 30), dropped, []), 'ASIA_SHORT')).toMatchObject({ state: 'dropped', reason: 'gate WAIT (DVOL 70 >= 65)' });
  });

  it('shows open and closed runs with their numbers, and the gated book beside the always book', () => {
    const runs = new Map([
      [`ASIA_SHORT:${day}:always`, run({ status: 'closed', netPnl: 4.2, exitReason: 'tp' })],
      [`ASIA_SHORT:${day}:gated`, run({ book: 'gated', status: 'closed', netPnl: 4.2, exitReason: 'tp' })],
      [`EVE_LONG:${day}:always`, run({ status: 'open' })],
    ]);
    const t = buildTimeline(at(18), runs, []);
    expect(find(t, 'ASIA_SHORT')).toMatchObject({ state: 'closed', run: { netPnl: 4.2, exitReason: 'tp' }, gated: { status: 'closed' } });
    expect(find(t, 'EVE_LONG').state).toBe('open');
  });

  it('keeps last night\'s New York strangle visible until it is closed, and hides finished yesterday slots', () => {
    const yesterday = '2026-10-25';
    const runs = new Map([[`NY_SHORT:${yesterday}:always`, run({ status: 'open', plannedExitAtMs: at(7) })]]);
    const t = buildTimeline(at(2, 0), runs, []);
    expect(find(t, 'NY_SHORT', yesterday).state).toBe('open');
    expect(t.some((s) => s.dateKey === yesterday && s.id === 'ASIA_SHORT')).toBe(false);
  });

  it('a calendar slot waits 30 minutes from 18:00', () => {
    expect(find(buildTimeline(at(18, 10), new Map(), []), 'CAL_BACK').state).toBe('waiting');
    expect(find(buildTimeline(at(18, 40), new Map(), []), 'CAL_BACK').state).toBe('missed');
  });
});
