import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPerpQuote, parseTicker } from './delta-public.js';

const base = {
  symbol: 'C-BTC-78400-021126',
  contract_type: 'call_options',
  strike_price: '78400',
  mark_price: '200.13',
  greeks: { delta: '0.2457' },
  quotes: { best_bid: '198', best_ask: '203', mark_iv: '0.2356' },
};

describe('parseTicker OI, volume and quote time', () => {
  it('reads oi_contracts, volume and timestamp (microseconds)', () => {
    const p = parseTicker({ ...base, oi_contracts: '5629', volume: 13.801, timestamp: 1793439259596683 });
    expect(p?.oi).toBe(5629);
    expect(p?.volume).toBeCloseTo(13.801);
    expect(p?.quoteTsMs).toBe(1793439259596);
  });

  it('leaves the fields undefined when missing or non-numeric', () => {
    const p = parseTicker(base);
    expect(p?.oi).toBeUndefined();
    expect(p?.volume).toBeUndefined();
    expect(p?.quoteTsMs).toBeUndefined();
    const q = parseTicker({ ...base, oi_contracts: 'abc', volume: undefined, timestamp: Number.NaN });
    expect(q?.oi).toBeUndefined();
    expect(q?.volume).toBeUndefined();
    expect(q?.quoteTsMs).toBeUndefined();
  });
});

describe('fetchPerpQuote', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (result: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result }) })));

  it('returns bid, ask, mark, spot and tsMs', async () => {
    stub({ mark_price: '78000.5', spot_price: '78010', quotes: { best_bid: '77999', best_ask: '78001' }, timestamp: 1793439259596683 });
    expect(await fetchPerpQuote()).toEqual({ bid: 77999, ask: 78001, mark: 78000.5, spot: 78010, tsMs: 1793439259596 });
  });

  it('throws on a missing or non-positive bid/ask', async () => {
    stub({ mark_price: '1', spot_price: '1', quotes: { best_ask: '78001' } });
    await expect(fetchPerpQuote()).rejects.toThrow();
    stub({ mark_price: '1', spot_price: '1', quotes: { best_bid: '0', best_ask: '78001' } });
    await expect(fetchPerpQuote()).rejects.toThrow();
  });
});
