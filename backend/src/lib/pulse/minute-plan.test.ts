import { describe, expect, it } from 'vitest';
import { minuteTargets } from './minute-plan.js';
import type { PulseCohort } from './snapshot.js';
import type { Slot } from './grid.js';

const H = 3_600_000;
const BASE = Date.parse('2026-11-01T00:00:00Z');

function cohort(id: string, slot: Slot, hour: number, over: Partial<PulseCohort> = {}): PulseCohort {
  const slot_ms = BASE + hour * H;
  return { id, slot, slot_ms, opened_at: slot_ms + 20_000, status: 'open', call_symbol: 'C', put_symbol: 'P', ...over } as PulseCohort;
}

describe('minuteTargets', () => {
  it('targets the newest strangle on the slot', () => {
    const live = [cohort('a', 'current', 0), cohort('b', 'current', 1), cohort('x', 'next', 2)];
    const now = BASE + 1 * H + 10 * 60_000;
    expect(minuteTargets(live, 'current', now).map((c) => c.id)).toEqual(['b']);
  });

  it('also targets the previous one for 5 minutes after a switch', () => {
    const live = [cohort('a', 'current', 0), cohort('b', 'current', 1)];
    expect(minuteTargets(live, 'current', BASE + 1 * H + 20_000 + 4 * 60_000).map((c) => c.id)).toEqual(['b', 'a']);
    expect(minuteTargets(live, 'current', BASE + 1 * H + 20_000 + 5 * 60_000).map((c) => c.id)).toEqual(['b']);
  });

  it('never targets futures_only cohorts', () => {
    const live = [cohort('a', 'current', 0), cohort('f', 'current', 1, { status: 'futures_only', call_symbol: null, put_symbol: null })];
    expect(minuteTargets(live, 'current', BASE + 1 * H + 60_000).map((c) => c.id)).toEqual(['a']);
    expect(minuteTargets([live[1]!], 'current', BASE + 1 * H + 60_000)).toEqual([]);
  });
});
