import { describe, it, expect } from 'vitest';
import { computeRecalibration, type SessionRec } from './recalibration.js';

const SEEDED = {
  tueWedStopRate: 38.0, speedStopRate: 44.3, comboStopRate: 32.6,
  comboPValue: 0.0012, oosStopRate: 28.4,
};
const OPTS = { minSample: 30, bonferroniAlpha: 0.001515, seeded: SEEDED };

function mk(n: number, dow: number, speed: number, stop: boolean): SessionRec[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    dow, speed, isStop: stop, sizing: 1, status: 'TRADED',
  }));
}

describe('computeRecalibration', () => {
  it('uses seeded baselines below minSample and labels the source', () => {
    const r = computeRecalibration(mk(5, 2, 1.0, false), OPTS);
    expect(r.source).toBe('seeded_baseline');
    expect(r.tueWedStopRate).toBe(38.0);
    expect(r.comboStopRate).toBe(32.6);
    expect(r.comboPValue).toBe(0.0012);
    expect(r.clearedBonferroni).toBe(true);
  });

  it('computes from real data at/above minSample and labels computed', () => {
    const sessions = [...mk(32, 2, 1.0, false), ...mk(8, 2, 1.0, true)];
    const r = computeRecalibration(sessions, OPTS);
    expect(r.source).toBe('computed');
    expect(r.comboStopRate).toBeCloseTo(20, 6);
    expect(r.totalSessions).toBe(40);
    expect(r.inSampleSessions).toBe(20);
    expect(r.outOfSampleSessions).toBe(20);
  });

  it('OOS slice is non-empty for any logs.length >= 2', () => {
    const r = computeRecalibration([...mk(1, 2, 1, false), ...mk(1, 2, 1, true)], {
      ...OPTS, minSample: 0,
    });
    expect(r.outOfSampleSessions).toBe(1);
    expect(r.oosStopRate).not.toBeNull();
  });
});
