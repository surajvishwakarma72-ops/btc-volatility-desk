import { describe, expect, it } from 'vitest';
import type { ChainOption } from '../../bot/strike-picker.js';
import { marketRow, termInverted } from './market.js';

const EXP = Date.parse('2026-10-31T12:00:00Z');
const GRID = Date.parse('2026-10-31T08:15:00Z');
const NOW = GRID + 5_000;
const SPOT = 100_000;

function opt(type: 'call' | 'put', strike: number, delta: number, iv: number, expiryMs = EXP): ChainOption {
  return { symbol: `${type[0].toUpperCase()}-${strike}-${expiryMs}`, type, strike, expiryMs, delta, bid: 10, ask: 12, mark: 11, iv };
}

/** Spot 100000: ATM pair at IV 50 and 52, call 0.24 delta at IV 48, put 0.26 delta at IV 53. */
const chain = (): ChainOption[] => [
  opt('call', 100_000, 0.5, 50), opt('put', 100_000, 0.5, 52),
  opt('call', 108_000, 0.24, 48), opt('put', 93_000, 0.26, 53),
  opt('call', 120_000, 0.05, 60), opt('put', 80_000, 0.05, 65),
];

describe('marketRow', () => {
  it('takes ATM as the mean of the pair nearest spot and rr25 from the 25-delta options', () => {
    const row = marketRow(chain(), 'current', EXP, SPOT, GRID, NOW);
    expect(row).toMatchObject({ grid_ms: GRID, slot: 'current', expiry_ms: EXP, sampled_ms: NOW, spot: SPOT, call25_iv: 48, put25_iv: 53 });
    expect(row.atm_iv).toBeCloseTo(51, 6);
    expect(row.rr25).toBeCloseTo(-5, 6);
  });

  it('ignores other expiries', () => {
    const other = [opt('call', 100_000, 0.5, 10, EXP + 1), opt('put', 100_000, 0.5, 10, EXP + 1), opt('call', 108_000, 0.25, 10, EXP + 1)];
    const row = marketRow([...other, ...chain()], 'next', EXP, SPOT, GRID, NOW);
    expect(row.atm_iv).toBeCloseTo(51, 6);
    expect(row.call25_iv).toBe(48);
  });

  it('leaves 25-delta null when nothing is within the band', () => {
    const c = chain().map((o) => (o.type === 'call' && o.strike === 108_000 ? { ...o, delta: 0.15 } : o));
    const row = marketRow(c, 'current', EXP, SPOT, GRID, NOW);
    expect(row.call25_iv).toBeNull();
    expect(row.rr25).toBeNull();
    expect(row.put25_iv).toBe(53);
    expect(row.atm_iv).toBeCloseTo(51, 6);
  });

  it('treats NaN IV as missing', () => {
    const c = chain().map((o) => (o.type === 'put' && o.strike === 93_000 ? { ...o, iv: NaN } : o));
    const row = marketRow(c, 'current', EXP, SPOT, GRID, NOW);
    expect(row.put25_iv).toBeNull();
    expect(row.rr25).toBeNull();
    const atmBroken = chain().map((o) => (o.type === 'put' && o.strike === 100_000 ? { ...o, iv: NaN } : o));
    // the only strike with both sides lost its put, so no strike qualifies
    expect(marketRow(atmBroken, 'current', EXP, SPOT, GRID, NOW).atm_iv).toBeNull();
  });

  it('treats non-positive IV as missing', () => {
    const c = chain().map((o) => (o.type === 'call' && o.strike === 108_000 ? { ...o, iv: 0 } : o));
    expect(marketRow(c, 'current', EXP, SPOT, GRID, NOW).call25_iv).toBeNull();
  });

  it('picks the strike nearest spot that has both sides', () => {
    const c = [opt('call', 99_000, 0.5, 40), opt('put', 99_000, 0.5, 44), opt('call', 100_500, 0.5, 70)];
    expect(marketRow(c, 'current', EXP, SPOT, GRID, NOW).atm_iv).toBeCloseTo(42, 6);
  });

  it('returns all nulls for an empty chain', () => {
    expect(marketRow([], 'current', EXP, SPOT, GRID, NOW)).toMatchObject({ atm_iv: null, call25_iv: null, put25_iv: null, rr25: null });
  });
});

describe('termInverted', () => {
  it('is true when current exceeds next', () => {
    expect(termInverted(55, 50)).toBe(true);
    expect(termInverted(50, 55)).toBe(false);
    expect(termInverted(50, 50)).toBe(false);
  });
  it('needs current above next by more than termInversionMinPts (0.5)', () => {
    expect(termInverted(50.5, 50)).toBe(false);
    expect(termInverted(50.51, 50)).toBe(true);
    expect(termInverted(50.3, 50)).toBe(false);
  });
  it('is null when either side is missing', () => {
    expect(termInverted(null, 50)).toBeNull();
    expect(termInverted(50, null)).toBeNull();
  });
});
