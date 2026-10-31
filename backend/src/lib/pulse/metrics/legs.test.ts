import { describe, it, expect } from 'vitest';
import { dsi, oiSignal, spreadPct, exitCostPct, median, liquidityBand, spreadVeto } from './legs.js';

describe('leg metrics', () => {
  it('dsi', () => {
    expect(dsi(0.02, 0.01, 100000, 101000)).toBeCloseTo(0.03, 6);
    expect(dsi(0.02, -0.01, 100000, 102000)).toBeCloseTo(0.015, 6);
    expect(dsi(0.02, -0.01, 100000, 99000)).toBeCloseTo(0.03, 6);
    expect(dsi(0.02, 0.01, 100000, 100010)).toBeNull(); // 0.01% move, below minMovePct
    expect(dsi(null, 0.01, 100000, 101000)).toBeNull();
    expect(dsi(0.02, 0.01, 0, 101000)).toBeNull();
  });
  it('oiSignal', () => {
    expect(oiSignal(-5, 100, 2)).toBe('short_buildup');
    expect(oiSignal(-5, -100, 2)).toBe('long_unwinding');
    expect(oiSignal(5, 100, 2)).toBe('long_buildup');
    expect(oiSignal(5, -100, 2)).toBe('short_covering');
    expect(oiSignal(5, 100, 0)).toBe('unconfirmed');
    expect(oiSignal(5, 100, null)).toBe('unconfirmed');
    expect(oiSignal(5, null, 2)).toBeNull();
    expect(oiSignal(0, 100, 2)).toBeNull();
    expect(oiSignal(null, 100, 2)).toBeNull();
    expect(oiSignal(5, 0, 2)).toBeNull();
  });
  it('spreadPct', () => {
    expect(spreadPct(90, 110, 100)).toBeCloseTo(0.2, 6);
    expect(spreadPct(90, 110, 0)).toBeNull();
    expect(spreadPct(null, 110, 100)).toBeNull();
  });
  it('exitCostPct', () => {
    expect(exitCostPct(110, 55, 100, 50, 200, 100)).toBeCloseTo(0.05, 6);
    expect(exitCostPct(110, 55, 100, 50, 0, 0)).toBeNull();
    expect(exitCostPct(null, 55, 100, 50, 200, 100)).toBeNull();
  });
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([NaN, Infinity])).toBeNull();
    expect(median([1, NaN, 3])).toBe(2);
  });
  it('liquidityBand', () => {
    expect(liquidityBand(0.049)).toBe('normal');
    expect(liquidityBand(0.05)).toBe('penalty');
    expect(liquidityBand(0.1)).toBe('penalty');
    expect(liquidityBand(0.101)).toBe('veto');
    expect(liquidityBand(null)).toBeNull();
  });
  it('spreadVeto', () => {
    expect(spreadVeto(0.11, null)).toBe(true);
    expect(spreadVeto(0.05, 0.02)).toBe(true);
    expect(spreadVeto(0.04, 0.02)).toBe(false);
    expect(spreadVeto(null, 0.02)).toBeNull(); // unknown, not "no veto"
    expect(spreadVeto(null, null)).toBeNull();
  });
});
