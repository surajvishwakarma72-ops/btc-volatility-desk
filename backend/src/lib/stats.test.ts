import { describe, it, expect } from 'vitest';
import { binomialCdfLowerTail } from './stats.js';

describe('binomialCdfLowerTail', () => {
  it('P(X<=2) for Bin(10, 0.5) ~= 0.0546875', () => {
    expect(binomialCdfLowerTail(2, 10, 0.5)).toBeCloseTo(0.0546875, 7);
  });

  it('P(X<=n) = 1', () => {
    expect(binomialCdfLowerTail(10, 10, 0.3)).toBeCloseTo(1, 10);
  });

  it('P(X<=-1) = 0', () => {
    expect(binomialCdfLowerTail(-1, 10, 0.3)).toBe(0);
  });

  it('is numerically stable for large n', () => {
    const p = binomialCdfLowerTail(400, 1000, 0.5);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.0001);
  });
});
