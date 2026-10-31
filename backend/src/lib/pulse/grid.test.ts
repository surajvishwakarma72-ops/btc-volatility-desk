import { describe, expect, it } from 'vitest';
import { cohortSlotMs, resolveSlots, snapshotGridMs } from './grid.js';

describe('pulse grid', () => {
  it('floors cohort slot to the UTC hour', () => {
    const t = Date.UTC(2026, 9, 31, 0, 7, 12);
    expect(cohortSlotMs(t)).toBe(Date.UTC(2026, 9, 31, 0, 0)); // 05:30 IST
  });

  it('floors snapshot time to 15 minutes', () => {
    expect(snapshotGridMs(Date.UTC(2026, 9, 31, 3, 44, 59))).toBe(Date.UTC(2026, 9, 31, 3, 30));
  });

  it('resolves expiry slots from a sorted list', () => {
    expect(resolveSlots([3, 1, 2])).toEqual({ current: 1, next: 2, n2n: 3 });
    expect(resolveSlots([5])).toEqual({ current: 5 });
  });
});
