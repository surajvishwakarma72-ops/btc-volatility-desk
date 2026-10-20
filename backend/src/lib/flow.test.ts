import { describe, it, expect } from 'vitest';
import { filterNewTrades, computeIvChangePct } from './flow.js';

describe('filterNewTrades', () => {
  const trades = [
    { trade_seq: 10 }, { trade_seq: 11 }, { trade_seq: 12 },
  ];

  it('returns all trades when no prior watermark', () => {
    const r = filterNewTrades(trades, null);
    expect(r.fresh.length).toBe(3);
    expect(r.maxSeq).toBe(12);
  });

  it('returns only trades newer than the watermark', () => {
    const r = filterNewTrades(trades, 11);
    expect(r.fresh.map((t) => t.trade_seq)).toEqual([12]);
    expect(r.maxSeq).toBe(12);
  });

  it('returns none and preserves watermark when all are stale', () => {
    const r = filterNewTrades(trades, 99);
    expect(r.fresh.length).toBe(0);
    expect(r.maxSeq).toBe(99);
  });
});

describe('computeIvChangePct', () => {
  it('returns null when previous is missing', () => {
    expect(computeIvChangePct(null, 40)).toBeNull();
  });
  it('computes signed percent change', () => {
    expect(computeIvChangePct(40, 44)).toBeCloseTo(10, 6);
    expect(computeIvChangePct(50, 45)).toBeCloseTo(-10, 6);
  });
});
