import { describe, expect, it } from 'vitest';
import { compareToAtm, decayToExitUsd, estimateProfit, lotsForCapital, thetaPerDayUsd } from './profit.js';

const sold = (theta: number, lots = 100) => ({ side: 'sell' as const, lots, theta, gamma: 0.00004, iv: 45 });
const bought = (theta: number, lots = 100) => ({ side: 'buy' as const, lots, theta, gamma: 0.0001, iv: 44 });

describe('time decay per day', () => {
  it('a sold leg earns its theta, a bought leg pays it; one lot is 0.001 BTC', () => {
    // theta -30 per BTC per day, 100 lots = 0.1 BTC: 3 dollars a day
    expect(thetaPerDayUsd([sold(-30)])).toBeCloseTo(3);
    expect(thetaPerDayUsd([sold(-30), sold(-20)])).toBeCloseTo(5);
    expect(thetaPerDayUsd([sold(-30), bought(-10)])).toBeCloseTo(3 - 1);
    expect(thetaPerDayUsd([bought(-30)])).toBeCloseTo(-3);
  });
  it('without a theta on any leg there is no number, not a guess', () => {
    expect(thetaPerDayUsd([sold(-30), { side: 'sell', lots: 10, theta: null }])).toBeNull();
    expect(thetaPerDayUsd([{ side: 'sell', lots: 10 }])).toBeNull();
  });
});

describe('estimated profit until the exit', () => {
  it('scales the daily decay by the hours to the exit and caps the story at the premium', () => {
    const e = estimateProfit([sold(-30), sold(-30)], 12, 8)!;
    expect(e.perDayUsd).toBeCloseTo(6);
    expect(e.toExitUsd).toBeCloseTo(3); // half a day
    expect(e.maxUsd).toBe(8);
    expect(e.hoursToExit).toBe(12);
    expect(e.note).toMatch(/before fees/);
  });
  it('is null when the exit is not ahead or a theta is missing', () => {
    expect(estimateProfit([sold(-30)], 0, 5)).toBeNull();
    expect(estimateProfit([sold(-30)], null, 5)).toBeNull();
    expect(estimateProfit([{ side: 'sell', lots: 1 }], 5, 5)).toBeNull();
  });
  it('no premium means no stated maximum', () => {
    expect(estimateProfit([sold(-30)], 24, null)!.maxUsd).toBeNull();
  });
});

describe('the estimate never beats the premium collected', () => {
  it('caps a straight-line decay that would exceed the premium', () => {
    const e = estimateProfit([sold(-30), sold(-30)], 120, 8)!;
    expect(e.toExitUsd).toBe(8);
  });
  it('re-prices the legs at the exit: a 2 day sold strangle earns well under its premium in a day', () => {
    const now = Date.UTC(2026, 9, 26, 9), ex = now + 2 * 86_400_000;
    const legs = [
      { side: 'sell' as const, lots: 200, theta: -60, iv: 40, strike: 75000, type: 'call' as const, expiryMs: ex },
      { side: 'sell' as const, lots: 200, theta: -60, iv: 40, strike: 66000, type: 'put' as const, expiryMs: ex },
    ];
    const d = decayToExitUsd(legs, 70000, 24, now)!;
    expect(d).toBeGreaterThan(0);
    const total = decayToExitUsd(legs, 70000, 48, now)!;
    expect(total).toBeGreaterThan(d);
  });
});

describe('gamma and IV of a leg against the at-the-money strike', () => {
  it('shows gamma as a share of ATM gamma and IV as a difference in vol points', () => {
    const c = compareToAtm(sold(-30), { gamma: 0.0002, iv: 43 });
    expect(c.gammaPctOfAtm).toBeCloseTo(20);
    expect(c.ivVsAtm).toBeCloseTo(2);
  });
  it('unknown values stay unknown', () => {
    expect(compareToAtm({ side: 'sell', lots: 1 }, { gamma: 0.0002, iv: 43 })).toEqual({ gammaPctOfAtm: null, ivVsAtm: null });
    expect(compareToAtm(sold(-30), { gamma: null, iv: null })).toEqual({ gammaPctOfAtm: null, ivVsAtm: null });
  });
});

describe('lots for a capital in rupees', () => {
  it('100 rupees per lot: 10,000 gives 100 lots and 5,000 gives 50', () => {
    expect(lotsForCapital(10_000)).toBe(100);
    expect(lotsForCapital(5_000)).toBe(50);
    expect(lotsForCapital(12_345)).toBe(123);
  });
  it('never fewer than one lot', () => {
    expect(lotsForCapital(40)).toBe(1);
    expect(lotsForCapital(0)).toBe(1);
  });
});
