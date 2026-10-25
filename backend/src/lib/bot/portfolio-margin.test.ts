import { describe, expect, it } from 'vitest';
import { portfolioMargin, shockSpans, type MarginPosition } from './portfolio-margin.js';

const NOW = Date.parse('2026-10-26T04:30:00Z');
const EXP3 = NOW + 3 * 86_400_000;
const SPOT = 80_800;

const shortCall: MarginPosition = { type: 'call', side: 'short', strike: 83000, expiryMs: EXP3, lots: 100, iv: 40 };
const shortPut: MarginPosition = { type: 'put', side: 'short', strike: 78500, expiryMs: EXP3, lots: 100, iv: 42 };

describe('shock spans (published tiers)', () => {
  it('matches the guide at the tier edges and the worked example', () => {
    expect(shockSpans(50_000)).toEqual({ price: 0.01, volDown: 0.06, volUp: 0.09 });
    const ex = shockSpans(1_100_000);
    expect(ex.price).toBeCloseTo(0.05, 6);
    expect(ex.volDown).toBeCloseTo(0.18, 6);
    expect(ex.volUp).toBeCloseTo(0.27, 6);
    expect(shockSpans(10_000_000)).toEqual({ price: 0.1, volDown: 0.3, volUp: 0.45 });
  });
});

describe('portfolioMargin', () => {
  it('is zero for an empty portfolio', () => {
    expect(portfolioMargin([], SPOT, NOW).margin).toBe(0);
  });

  it('a small short strangle is margined near the floor, far below 10% of notional', () => {
    const r = portfolioMargin([shortCall, shortPut], SPOT, NOW);
    expect(r.margin).toBeGreaterThan(0);
    expect(r.margin).toBeLessThan(0.1 * 2 * SPOT * 100 * 0.001);
    expect(r.margin).toBeGreaterThanOrEqual(r.floor);
  });

  it('adding bought wings does not increase margin (risk is defined)', () => {
    const naked = portfolioMargin([shortCall, shortPut], SPOT, NOW).margin;
    const wingC: MarginPosition = { type: 'call', side: 'long', strike: 85000, expiryMs: EXP3, lots: 100, iv: 38 };
    const wingP: MarginPosition = { type: 'put', side: 'long', strike: 76500, expiryMs: EXP3, lots: 100, iv: 45 };
    const ic = portfolioMargin([shortCall, shortPut, wingC, wingP], SPOT, NOW).riskMargin;
    const nakedRisk = portfolioMargin([shortCall, shortPut], SPOT, NOW).riskMargin;
    expect(ic).toBeLessThanOrEqual(nakedRisk + 1e-9);
    expect(naked).toBeGreaterThan(0);
  });

  it('a long straddle needs no more than a loose premium bound', () => {
    const lc: MarginPosition = { type: 'call', side: 'long', strike: 81000, expiryMs: EXP3, lots: 100, iv: 40 };
    const lp: MarginPosition = { type: 'put', side: 'long', strike: 81000, expiryMs: EXP3, lots: 100, iv: 40 };
    const r = portfolioMargin([lc, lp], SPOT, NOW);
    expect(r.margin).toBeGreaterThan(0);
    expect(r.margin).toBeLessThan(2 * 0.001 * 100 * 2500);
  });

  it('a calendar (short front, long back) nets down the risk vs the naked short front', () => {
    const front: MarginPosition = { type: 'call', side: 'short', strike: 81000, expiryMs: EXP3, lots: 100, iv: 45 };
    const back: MarginPosition = { type: 'call', side: 'long', strike: 81000, expiryMs: EXP3 + 2 * 86_400_000, lots: 100, iv: 38 };
    const nakedRisk = portfolioMargin([front], SPOT, NOW).riskMargin;
    const calRisk = portfolioMargin([front, back], SPOT, NOW).riskMargin;
    expect(calRisk).toBeLessThan(nakedRisk);
  });

  it('wider notional widens the spans and raises risk margin per lot', () => {
    const small = portfolioMargin([shortCall, shortPut], SPOT, NOW);
    const big = portfolioMargin([{ ...shortCall, lots: 20000 }, { ...shortPut, lots: 20000 }], SPOT, NOW);
    expect(big.spans.price).toBeGreaterThan(small.spans.price);
    expect(big.riskMargin / (20000 * 2)).toBeGreaterThan(small.riskMargin / (100 * 2));
  });

  it('reports the worst scenario', () => {
    const r = portfolioMargin([shortCall, shortPut], SPOT, NOW);
    expect(r.worstScenario).not.toBeNull();
    expect(r.worstScenario!.loss).toBeCloseTo(r.riskMargin, 9);
  });
});

import { MARGIN_CALIBRATION } from './portfolio-margin.js';

describe('calibration to Delta', () => {
  it('a 100-lot short strangle lands in the $100 to $300 band Delta shows, and bought options stay at their premium', () => {
    expect(MARGIN_CALIBRATION).toBe(2.5);
    const strangle = portfolioMargin([{ ...shortCall, strike: 82500, iv: 38 }, { ...shortPut, strike: 78500, iv: 40 }], SPOT, NOW).margin;
    expect(strangle).toBeGreaterThan(100);
    expect(strangle).toBeLessThan(300);
    const longOnly = portfolioMargin([{ type: 'call', side: 'long', strike: 80800, expiryMs: EXP3, lots: 100, iv: 40 }], SPOT, NOW);
    expect(longOnly.margin).toBeLessThanOrEqual(longOnly.notional * 0.05); // not inflated by the factor
  });
});
