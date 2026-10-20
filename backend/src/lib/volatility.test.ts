import { describe, it, expect } from 'vitest';
import { garmanKlassRv, computeVelocityPct } from './volatility.js';

describe('garmanKlassRv', () => {
  it('returns 0 for fewer than 5 bars', () => {
    expect(garmanKlassRv([{ open: 1, high: 1, low: 1, close: 1 }])).toBe(0);
  });

  it('returns 0 (not NaN) for flat bars', () => {
    const bars = Array.from({ length: 6 }, () => ({ open: 100, high: 100, low: 100, close: 100 }));
    expect(garmanKlassRv(bars)).toBe(0);
  });

  it('produces a positive finite annualized percentage for moving bars', () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({
      open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
    }));
    const rv = garmanKlassRv(bars);
    expect(Number.isFinite(rv)).toBe(true);
    expect(rv).toBeGreaterThan(0);
  });
});

describe('computeVelocityPct', () => {
  it('returns 0 when there are not enough closes', () => {
    expect(computeVelocityPct([100, 101], 3)).toBe(0);
  });

  it('computes absolute percent move over the window', () => {
    expect(computeVelocityPct([100, 105, 108, 110], 3)).toBeCloseTo(10, 6);
  });

  it('is absolute (down moves are positive)', () => {
    expect(computeVelocityPct([100, 98, 95, 90], 3)).toBeCloseTo(10, 6);
  });
});
