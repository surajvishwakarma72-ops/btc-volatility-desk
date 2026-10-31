import { describe, it, expect } from 'vitest';
import { decayEfficiency, balanceDrift, heavyLeg, ivChange, expectedMove, rangeRatio } from './premium.js';

describe('premium metrics', () => {
  it('decayEfficiency', () => {
    expect(decayEfficiency(100, 70, -240, 0.25)).toBeCloseTo(0.5, 6);
    expect(decayEfficiency(100, 70, 0, 0.25)).toBeNull();
    expect(decayEfficiency(100, 70, -240, 0)).toBeNull();
    expect(decayEfficiency(null, 70, -240, 0.25)).toBeNull();
  });
  it('balanceDrift', () => {
    expect(balanceDrift(100, 100, 200, 100)).toBeCloseTo(0.693147, 6);
    expect(balanceDrift(100, 100, 0, 100)).toBeNull();
    expect(balanceDrift(null, 100, 200, 100)).toBeNull();
  });
  it('heavyLeg', () => {
    expect(heavyLeg(100, 100, 120, 80)).toBe('call');
    expect(heavyLeg(100, 100, 90, 85)).toBeNull();
    expect(heavyLeg(100, 100, 70, 90)).toBe('put');
    expect(heavyLeg(0, 100, 70, 90)).toBeNull();
  });
  it('ivChange', () => {
    expect(ivChange(55, 50)).toBeCloseTo(5, 6);
    expect(ivChange(null, 50)).toBeNull();
  });
  it('expectedMove', () => {
    expect(expectedMove(100000, 50, 36.5)).toBeCloseTo(15811.388, 2);
    expect(expectedMove(100000, 50, 0)).toBeNull();
    expect(expectedMove(null, 50, 1)).toBeNull();
  });
  it('rangeRatio', () => {
    expect(rangeRatio([100000, 103000, 97094.3], 11811.4)).toBeCloseTo(0.5, 3);
    expect(rangeRatio([100000], null)).toBeNull();
    expect(rangeRatio([], 100)).toBeNull();
    expect(rangeRatio([1, 2], 0)).toBeNull();
  });
});
