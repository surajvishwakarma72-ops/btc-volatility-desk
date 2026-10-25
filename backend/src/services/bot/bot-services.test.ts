import { describe, expect, it } from 'vitest';
import { parseExpiry, parseTicker, type Book, type FeeRates } from './delta-public.js';
import { paperExecute, type PlannedLeg } from './paper-broker.js';

describe('delta option parsing', () => {
  it('reads the DDMMYY expiry as 12:00 UTC (17:30 IST)', () => {
    expect(parseExpiry('C-BTC-99000-271126')).toBe(Date.UTC(2026, 10, 27, 12));
    expect(parseExpiry('P-BTC-78500-251026')).toBe(Date.UTC(2026, 9, 25, 12));
    expect(parseExpiry('BTCUSD')).toBeNull();
  });

  it('turns a ticker into a chain option: abs delta, IV as vol points, missing bid as 0', () => {
    const t = parseTicker({
      symbol: 'P-BTC-99000-271126',
      contract_type: 'put_options',
      strike_price: '99000',
      mark_price: '17866',
      greeks: { delta: '-0.95824888', gamma: '0.00000972', theta: '-12.2', vega: '21.8' },
      quotes: { best_bid: '17766', best_ask: '17966', mark_iv: '0.375' },
    });
    expect(t).toMatchObject({ type: 'put', strike: 99000, delta: 0.95824888, bid: 17766, ask: 17966 });
    expect(t!.iv).toBeCloseTo(37.5, 6);
    const noQuote = parseTicker({ symbol: 'C-BTC-90000-271126', contract_type: 'call_options', strike_price: '90000', greeks: { delta: '0.2' }, quotes: null });
    expect(noQuote!.bid).toBe(0);
    expect(parseTicker({ symbol: 'C-BTC-90000-271126', contract_type: 'call_options', strike_price: '90000' })).toBeNull();
    expect(parseTicker({ symbol: 'BTCUSD', contract_type: 'perpetual_futures' })).toBeNull();
  });
});

const rates = new Map<string, FeeRates>([
  ['C', { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 }],
  ['P', { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 }],
]);

const books = new Map<string, Book>([
  ['C', { bids: [[100, 60], [99, 60]], asks: [[104, 60], [106, 60]] }],
  ['P', { bids: [[50, 40], [48, 100]], asks: [[55, 200]] }],
]);

const short = (symbol: string, intended: number): PlannedLeg => ({
  symbol, type: symbol === 'C' ? 'call' : 'put', side: 'short', strike: 1, expiryMs: 1, lots: 100, role: 'body', intendedPrice: intended,
});

describe('paper broker', () => {
  it('sells shorts into the bids, walking depth, and charges fees', () => {
    const r = paperExecute([short('C', 100), short('P', 50)], 'entry', books, rates, 80_000, 0);
    expect(r.ok).toBe(true);
    // C: 60 @100 + 40 @99 = 99.6; P: 40 @50 + 60 @48 = 48.8
    expect(r.fills[0]!.avgPrice).toBeCloseTo(99.6, 6);
    expect(r.fills[1]!.avgPrice).toBeCloseTo(48.8, 6);
    expect(r.fees).toBeGreaterThan(0);
    expect(r.fills.every((f) => f.side === 'sell' && f.action === 'entry')).toBe(true);
  });

  it('exits buy shorts back from the asks, with the extra-tick penalty applied against us', () => {
    const noPad = paperExecute([short('C', 100)], 'exit', books, rates, 80_000, 0);
    const padded = paperExecute([short('C', 100)], 'exit', books, rates, 80_000, 2, 0.5);
    expect(noPad.fills[0]!.side).toBe('buy');
    expect(noPad.fills[0]!.avgPrice).toBeCloseTo((60 * 104 + 40 * 106) / 100, 6);
    expect(padded.fills[0]!.avgPrice).toBeCloseTo(noPad.fills[0]!.avgPrice + 1, 6);
  });

  it('refuses a half-built position when the book is too thin or missing', () => {
    const thin = paperExecute([short('P', 50)], 'exit', books, rates, 80_000, 0); // asks only 200 -> ok
    expect(thin.ok).toBe(true);
    const tooMuch = paperExecute([{ ...short('C', 100), lots: 500 }], 'entry', books, rates, 80_000, 0);
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.reason).toMatch(/fills 120\/500/);
    expect(paperExecute([short('X', 1)], 'entry', books, rates, 80_000, 0)).toMatchObject({ ok: false });
  });
});
