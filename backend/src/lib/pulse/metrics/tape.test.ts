import { describe, it, expect } from 'vitest';
import { winnerSide, winnerPersistence, breakevens, moveVsBreakeven, efficiencyRatio, sessionBaseline } from './tape.js';

describe('tape metrics', () => {
  it('winnerSide', () => {
    expect(winnerSide(5, -2)).toBe('long');
    expect(winnerSide(-5, 2)).toBe('short');
    expect(winnerSide(1, 1)).toBeNull();
    expect(winnerSide(null, 1)).toBeNull();
  });
  it('winnerPersistence', () => {
    expect(winnerPersistence(['long', 'long', 'short', 'long', 'long', 'long', 'short'])).toEqual({ side: 'long', count: 5 });
    expect(winnerPersistence(['long', 'short', 'long', 'short', 'long', 'short'])).toBeNull();
    expect(winnerPersistence([])).toBeNull();
    expect(winnerPersistence([null, null])).toBeNull();
  });
  it('breakevens', () => {
    expect(breakevens(105000, 95000, 1000)).toEqual({ up: 106000, down: 94000 });
    expect(breakevens(105000, 95000, null)).toBeNull();
  });
  it('moveVsBreakeven', () => {
    expect(moveVsBreakeven(100000, [100500, 96400, 101000], 100000, { up: 106000, down: 94000 })).toBeCloseTo(0.6, 6);
    expect(moveVsBreakeven(100000, [], 100000, { up: 106000, down: 94000 })).toBeNull();
    expect(moveVsBreakeven(100000, [101000], 100000, { up: 100000, down: 94000 })).toBeNull();
    expect(moveVsBreakeven(null, [101000], 100000, { up: 106000, down: 94000 })).toBeNull();
  });
  it('efficiencyRatio', () => {
    expect(efficiencyRatio([100, 110, 100, 120])).toBeCloseTo(0.5, 6);
    expect(efficiencyRatio([100, 100, 100])).toBeNull();
    expect(efficiencyRatio([100])).toBeNull();
  });
  it('sessionBaseline', () => {
    expect(sessionBaseline([1, 1, 1, 1, 2, 2, 2, 2, 2, 2], 1)).toEqual({ median: 2, ratio: 0.5 });
    expect(sessionBaseline([1, 2, 3], 2)).toBeNull();
    expect(sessionBaseline([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1)).toBeNull();
    expect(sessionBaseline([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], null)).toBeNull();
  });
});
