import { describe, expect, it } from 'vitest';
import { describeFlow, parseDeribitInstrument, summariseTrades, type DeribitTrade } from './option-flow.js';

const NOW = Date.parse('2026-10-28T06:00:00Z');
const tr = (over: Partial<DeribitTrade>): DeribitTrade => ({
  instrument_name: 'BTC-30OCT26-80000-C', direction: 'buy', amount: 2, price: 0.004, index_price: 80_000, iv: 40, timestamp: NOW - 600_000, ...over,
});

describe('parseDeribitInstrument', () => {
  it('reads strike, type and expiry, and rejects other names', () => {
    expect(parseDeribitInstrument('BTC-28OCT26-80000-C')).toEqual({ type: 'call', strike: 80000, expiry: '28OCT26' });
    expect(parseDeribitInstrument('BTC-5NOV26-76000-P')).toEqual({ type: 'put', strike: 76000, expiry: '5NOV26' });
    expect(parseDeribitInstrument('BTC-PERPETUAL')).toBeNull();
    expect(parseDeribitInstrument('ETH-28OCT26-3000-C')).toBeNull();
  });
});

describe('summariseTrades', () => {
  it('adds buy and sell volume per strike and side, premium in USD, within the window only', () => {
    const s = summariseTrades([
      tr({}), tr({ direction: 'sell', amount: 1 }), tr({ instrument_name: 'BTC-30OCT26-80000-P', amount: 3 }),
      tr({ instrument_name: 'BTC-30OCT26-82000-C', direction: 'sell', amount: 5 }),
      tr({ timestamp: NOW - 5 * 3_600_000 }), // too old for a 4h window
    ], NOW, 4);
    expect(s.strikes.map((x) => x.strike)).toEqual([80000, 82000]);
    const k80 = s.strikes[0]!;
    expect(k80.call).toMatchObject({ buy: 2, sell: 1, trades: 2 });
    expect(k80.call.premiumUsd).toBeCloseTo(0.004 * 2 * 80_000 + 0.004 * 1 * 80_000, 6);
    expect(k80.put).toMatchObject({ buy: 3, sell: 0 });
    expect(s.totals.call.sell).toBe(6);
  });

  it('lists the biggest prints (10 BTC or a block) by premium, largest first', () => {
    const s = summariseTrades([tr({ amount: 12, price: 0.003 }), tr({ amount: 4, block_trade_id: 'b1', price: 0.02 }), tr({ amount: 3 })], NOW, 24);
    expect(s.big).toHaveLength(2);
    expect(s.big[0]!.block).toBe(true);
    expect(s.big[0]!.premiumUsd).toBeGreaterThan(s.big[1]!.premiumUsd);
  });

  it('ignores junk rows', () => {
    expect(summariseTrades([tr({ amount: 0 }), tr({ instrument_name: 'BTC-PERPETUAL' })], NOW, 4).strikes).toEqual([]);
  });
});

describe('describeFlow', () => {
  it('says nothing was traded, then reads the balance of calls and puts without predicting', () => {
    expect(describeFlow({ callBuy: 0, callSell: 0, putBuy: 0, putSell: 0, blockVol: 0, trades: 0 })).toMatch(/No option trades/);
    const d = describeFlow({ callBuy: 60, callSell: 10, putBuy: 5, putSell: 25, blockVol: 40, trades: 99 });
    expect(d).toMatch(/70% of volume was calls, 30% puts/);
    expect(d).toMatch(/calls mostly bought, puts mostly sold/);
    expect(d).toMatch(/40 BTC in blocks/);
    expect(describeFlow({ callBuy: 10, callSell: 10, putBuy: 10, putSell: 10, blockVol: 0, trades: 4 })).toMatch(/calls balanced, puts balanced/);
  });
});
