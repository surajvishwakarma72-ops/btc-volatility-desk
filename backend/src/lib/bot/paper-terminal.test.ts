import { describe, expect, it } from 'vitest';
import {
  accountView, applyTrade, cashDelta, feeFor, intrinsicAtExpiry, limitTradesThrough, shouldLiquidate, stopTriggered, unrealized, validateOrder, walk,
  type Instrument, type Position, type Quote,
} from './paper-terminal.js';

const perp: Instrument = { symbol: 'BTCUSD', kind: 'perp', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, premiumCapRate: 0, tick: 0.5, maxLeverage: 100 };
const EXP = Date.parse('2026-10-30T12:00:00Z');
const NOW = Date.parse('2026-10-28T06:00:00Z');
const call: Instrument = {
  symbol: 'C-BTC-82000-301026', kind: 'option', contractValue: 0.001, takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, tick: 5, maxLeverage: 1,
  option: { type: 'call', strike: 82000, expiryMs: EXP, iv: 40 },
};
const insts = new Map([[perp.symbol, perp], [call.symbol, call]]);
const marks = (q: Record<string, Quote>, spot = 80000) => ({ spot, nowMs: NOW, quote: (s: string) => q[s] });
const pos = (symbol: string, lots: number, avgEntry: number, leverage = 10): Position => ({ symbol, lots, avgEntry, leverage, realized: 0 });

describe('walk', () => {
  const asks = [[100, 5], [101, 5], [105, 50]] as const;
  it('averages across levels and reports the best price', () => {
    const w = walk(asks, 'buy', 8);
    expect(w.filled).toBe(8);
    expect(w.avgPrice).toBeCloseTo((5 * 100 + 3 * 101) / 8, 9);
    expect(w.best).toBe(100);
  });
  it('stops at the limit and can fill partly or not at all', () => {
    expect(walk(asks, 'buy', 20, 101).filled).toBe(10);
    expect(walk(asks, 'buy', 20, 99).filled).toBe(0);
    expect(walk([[99, 4], [98, 4]], 'sell', 6, 98.5).filled).toBe(4);
  });
});

describe('positions', () => {
  it('opens, adds at a weighted price, reduces with realised PnL, and flips', () => {
    let r = applyTrade(null, 10, 80000, 0.001, 10, 'BTCUSD');
    expect(r.pos).toMatchObject({ lots: 10, avgEntry: 80000 });
    r = applyTrade(r.pos, 10, 81000, 0.001, 10, 'BTCUSD');
    expect(r.pos!.avgEntry).toBeCloseTo(80500, 9);
    r = applyTrade(r.pos, -5, 82000, 0.001, 10, 'BTCUSD');
    expect(r.realized).toBeCloseTo(5 * 0.001 * 1500, 9);
    expect(r.pos!.lots).toBe(15);
    r = applyTrade(r.pos, -20, 79000, 0.001, 10, 'BTCUSD'); // closes 15 at a loss, opens 5 short at 79000
    expect(r.realized).toBeCloseTo(15 * 0.001 * (79000 - 80500), 9);
    expect(r.pos).toMatchObject({ lots: -5, avgEntry: 79000 });
  });
  it('a short profits when price falls', () => {
    const p = pos('BTCUSD', -10, 80000);
    expect(unrealized(p, 79000, 0.001)).toBeCloseTo(10, 9);
    expect(applyTrade(p, 10, 79000, 0.001, 10, 'BTCUSD').realized).toBeCloseTo(10, 9);
  });
});

describe('fees and cash', () => {
  it('uses maker or taker rate with GST, and options fees capped by the premium', () => {
    const taker = feeFor(perp, 80000, 100, 80000, false);
    const maker = feeFor(perp, 80000, 100, 80000, true);
    expect(taker).toBeCloseTo(0.0005 * 80000 * 100 * 0.001 * 1.18, 9);
    expect(maker).toBeLessThan(taker);
    // a 0.5 USD option: the 3.5% premium cap binds before the notional rate
    const f = feeFor(call, 0.5, 100, 80000, false);
    expect(f).toBeCloseTo(0.035 * 0.5 * 100 * 0.001 * 1.18, 9);
  });
  it('options move premium through cash; the perpetual only realised PnL and fees', () => {
    expect(cashDelta(call, 'buy', 100, 300, 1, 0)).toBeCloseTo(-30 - 1, 9);
    expect(cashDelta(call, 'sell', 100, 300, 1, 0)).toBeCloseTo(30 - 1, 9);
    expect(cashDelta(perp, 'buy', 10, 80000, 0.5, 0)).toBeCloseTo(-0.5, 9);
    expect(cashDelta(perp, 'sell', 10, 80000, 0.5, 12)).toBeCloseTo(11.5, 9);
  });
});

describe('account view', () => {
  const q = { BTCUSD: { bid: 79999, ask: 80001, mark: 80000 }, [call.symbol]: { bid: 290, ask: 310, mark: 300 } };
  it('an empty account is all cash and available', () => {
    const v = accountView({ cash: 10_000, startBalance: 10_000 }, [], insts, marks(q));
    expect(v).toMatchObject({ equity: 10_000, margin: 0, available: 10_000, marginRatio: null });
  });
  it('perpetual margin is notional over leverage, and unrealised PnL counts toward equity', () => {
    const v = accountView({ cash: 10_000, startBalance: 10_000 }, [pos('BTCUSD', 100, 79000, 20)], insts, marks(q));
    expect(v.perpMargin).toBeCloseTo((100 * 0.001 * 80000) / 20, 9);
    expect(v.perpUnrealized).toBeCloseTo(100 * 0.001 * 1000, 9);
    expect(v.equity).toBeCloseTo(10_100, 9);
    expect(v.available).toBeCloseTo(10_100 - 400, 9);
  });
  it('long options are an asset at mark; short options need portfolio margin', () => {
    const long = accountView({ cash: 10_000 - 30, startBalance: 10_000 }, [pos(call.symbol, 100, 300)], insts, marks(q));
    expect(long.optionsValue).toBeCloseTo(30, 9);
    expect(long.equity).toBeCloseTo(10_000, 9);
    const short = accountView({ cash: 10_000 + 30, startBalance: 10_000 }, [pos(call.symbol, -100, 300)], insts, marks(q));
    expect(short.optionsValue).toBeCloseTo(-30, 9);
    expect(short.optionMargin).toBeGreaterThan(0);
    expect(short.equity).toBeCloseTo(10_000, 9);
  });
  it('liquidates when equity falls below half of the margin in use', () => {
    const risky = accountView({ cash: 30, startBalance: 10_000 }, [pos('BTCUSD', 1000, 80000, 50)], insts, marks(q));
    // margin = 1000*0.001*80000/50 = 1600; equity = 30 -> far under 800
    expect(shouldLiquidate(risky)).toBe(true);
    const fine = accountView({ cash: 10_000, startBalance: 10_000 }, [pos('BTCUSD', 100, 80000, 20)], insts, marks(q));
    expect(shouldLiquidate(fine)).toBe(false);
  });
});

describe('resting orders', () => {
  it('stops trigger on the right side of the mark', () => {
    expect(stopTriggered('sell', 79000, 78999)).toBe(true);
    expect(stopTriggered('sell', 79000, 79500)).toBe(false);
    expect(stopTriggered('buy', 81000, 81000)).toBe(true);
    expect(stopTriggered('buy', 81000, 80500)).toBe(false);
  });
  it('limit orders fill only when the market trades strictly through them', () => {
    expect(limitTradesThrough('buy', 80000, { bid: 79990, ask: 79999 })).toBe(true);
    expect(limitTradesThrough('buy', 80000, { bid: 79990, ask: 80000 })).toBe(false); // touching is not enough
    expect(limitTradesThrough('sell', 80000, { bid: 80001, ask: 80010 })).toBe(true);
    expect(limitTradesThrough('sell', 80000, { bid: 80000, ask: 80010 })).toBe(false);
  });
});

describe('validation and expiry', () => {
  it('rejects bad orders with a reason', () => {
    expect(validateOrder({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 0 }, perp, null)).toMatch(/whole number/);
    expect(validateOrder({ symbol: 'BTCUSD', side: 'buy', type: 'limit', lots: 1 }, perp, null)).toMatch(/needs a positive price/);
    expect(validateOrder({ symbol: 'BTCUSD', side: 'buy', type: 'stop_market', lots: 1 }, perp, null)).toMatch(/stop price/);
    expect(validateOrder({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 1, leverage: 500 }, perp, null)).toMatch(/between 1 and 100/);
    expect(validateOrder({ symbol: call.symbol, side: 'buy', type: 'market', lots: 1, leverage: 5 }, call, null)).toMatch(/perpetual only/);
    expect(validateOrder({ symbol: 'BTCUSD', side: 'sell', type: 'market', lots: 1, reduceOnly: true }, perp, null)).toMatch(/no open position/);
    expect(validateOrder({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 1, reduceOnly: true }, perp, pos('BTCUSD', 5, 80000))).toMatch(/increase/);
    expect(validateOrder({ symbol: 'BTCUSD', side: 'sell', type: 'market', lots: 1, reduceOnly: true }, perp, pos('BTCUSD', 5, 80000))).toBeNull();
  });
  it('expired options settle at intrinsic value', () => {
    expect(intrinsicAtExpiry('call', 82000, 83000)).toBe(1000);
    expect(intrinsicAtExpiry('call', 82000, 81000)).toBe(0);
    expect(intrinsicAtExpiry('put', 79000, 78000)).toBe(1000);
  });
});
