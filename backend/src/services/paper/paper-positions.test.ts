import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Instrument } from '../../lib/bot/paper-terminal.js';
import type { Book } from '../bot/delta-public.js';
import type { BoardRow, MarketProvider, MarketSnapshot } from './market.js';

/** Strategy positions: net and per-leg PnL, the default 2x stop on sold legs, one stopped leg closes everything. */
const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));
vi.mock('../../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) {
        const res = await h.db.exec(text);
        const last = res[res.length - 1];
        return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 };
      }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  },
}));

const { PaperTerminal, ensurePaperSchema } = await import('./paper-terminal.js');

const EXP = Date.now() + 2 * 86_400_000;
const ds = new Date(EXP).toISOString();
const DATE = `${ds.slice(8, 10)}${ds.slice(5, 7)}${ds.slice(2, 4)}`;
const sym = (c: 'C' | 'P', k: number) => `${c}-BTC-${k}-${DATE}`;
const STRIKES = [74000, 76000, 78000, 80000, 82000, 84000, 86000];
const mk = { px: 80_000, depth: 5000, bump: new Map<string, number>() };

const timeValue = (k: number) => 500 * Math.exp(-(((k - 80_000) / 3000) ** 2)) + 5;
const markOf = (c: 'C' | 'P', k: number) => (c === 'C' ? Math.max(mk.px - k, 0) : Math.max(k - mk.px, 0)) + timeValue(k) + (mk.bump.get(sym(c, k)) ?? 0);

const perp: Instrument = { symbol: 'BTCUSD', kind: 'perp', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, premiumCapRate: 0, tick: 0.5, maxLeverage: 100 };
const inst = (c: 'C' | 'P', k: number): Instrument => ({
  symbol: sym(c, k), kind: 'option', contractValue: 0.001, takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, tick: 0.1, maxLeverage: 1,
  option: { type: c === 'C' ? 'call' : 'put', strike: k, expiryMs: EXP, iv: 40 },
});

function snapshot(): MarketSnapshot {
  const rows: BoardRow[] = [];
  const insts = new Map<string, Instrument>([['BTCUSD', perp]]);
  for (const k of STRIKES) {
    for (const c of ['C', 'P'] as const) {
      const m = markOf(c, k);
      rows.push({ symbol: sym(c, k), type: c === 'C' ? 'call' : 'put', strike: k, expiryMs: EXP, bid: m - 5, ask: m + 5, bidSize: 1000, askSize: 1000, mark: m, iv: 40, delta: 0.3, gamma: 0, theta: 0, vega: 0, oi: 0, volume: 0, tick: 0.1 });
      insts.set(sym(c, k), inst(c, k));
    }
  }
  return { at: Date.now(), spot: mk.px, perp: { symbol: 'BTCUSD', mark: mk.px, bid: mk.px - 0.5, ask: mk.px + 0.5, last: mk.px, funding: 0, oi: 0 }, rows, expiries: [EXP], insts };
}

const market: MarketProvider = {
  snapshot: async () => snapshot(),
  book: async (s: string): Promise<Book> => {
    if (s === 'BTCUSD') return { bids: [[mk.px - 0.5, 5000]], asks: [[mk.px + 0.5, 5000]] };
    const m = /^([CP])-BTC-(\d+)-/.exec(s)!;
    const x = markOf(m[1] as 'C' | 'P', Number(m[2]));
    return { bids: [[x - 5, mk.depth], [x - 15, mk.depth]], asks: [[x + 5, mk.depth], [x + 15, mk.depth]] };
  },
};

let t: InstanceType<typeof PaperTerminal>;
beforeAll(async () => {
  h.db = new PGlite() as never;
  await ensurePaperSchema();
});
afterAll(() => undefined);
beforeEach(async () => {
  mk.px = 80_000; mk.depth = 5000; mk.bump.clear();
  t = new PaperTerminal(market);
  await t.reset(10_000);
});

const strangle = (lots = 100) => [
  { symbol: sym('P', 76000), side: 'sell' as const, lots },
  { symbol: sym('C', 84000), side: 'sell' as const, lots },
];

describe('strategy positions', () => {
  it('shows an executed strangle with a 2x stop on each sold leg, and zero-ish pnl just after the fill', async () => {
    const r: any = await t.placeBasket(strangle());
    expect(r.ok).toBe(true);
    const s = (await t.strategies()).open;
    expect(s).toHaveLength(1);
    expect(s[0]!.legs).toHaveLength(2);
    for (const l of s[0]!.legs) {
      expect(l.stop).toBeCloseTo(l.entry * 2, 0);
      expect(l.stopDistancePct).toBeGreaterThan(0);
    }
    expect(s[0]!.marginAtEntry).toBeGreaterThan(0);
    // sold at the bid, valued at the mark: a few dollars of spread, never a big number
    expect(Math.abs(s[0]!.netPnl!)).toBeLessThan(5);
  });

  it('net pnl is the sum of the legs minus fees, and each leg moves with its own price', async () => {
    await t.placeBasket(strangle());
    mk.bump.set(sym('C', 84000), 3); // the call gets $3 dearer: a loss on the short call
    const s = (await t.strategies()).open[0]!;
    const call = s.legs.find((l) => l.symbol === sym('C', 84000))!;
    const put = s.legs.find((l) => l.symbol === sym('P', 76000))!;
    expect(call.pnl!).toBeCloseTo(-(call.mark! - call.entry) * 100 * 0.001, 8);
    expect(call.pnl!).toBeLessThan(put.pnl!);
    expect(s.netPnl!).toBeCloseTo(s.legs.reduce((a, l) => a + l.pnl!, 0) - s.fees, 8);
    expect(s.fees).toBeGreaterThan(0);
  });

  it('one leg reaching its stop closes both legs on the next tick and records why', async () => {
    await t.placeBasket(strangle());
    const before = (await t.strategies()).open[0]!;
    const callEntry = before.legs.find((l) => l.symbol === sym('C', 84000))!.entry;
    mk.bump.set(sym('C', 84000), callEntry * 1.5); // mark ends well above 2x entry
    await t.tick();
    const s = await t.strategies();
    expect(s.open).toHaveLength(0);
    expect(s.closed).toHaveLength(1);
    expect(s.closed[0]!.closeReason).toMatch(/stop: C-BTC-84000/);
    expect(s.closed[0]!.legs.every((l) => l.exit != null)).toBe(true);
    expect(s.closed[0]!.netPnl!).toBeLessThan(0);
    expect((await t.account()).positions).toHaveLength(0);
  });

  it('a price that has not reached the stop leaves the strategy alone', async () => {
    await t.placeBasket(strangle());
    mk.bump.set(sym('C', 84000), 20);
    await t.tick();
    expect((await t.strategies()).open).toHaveLength(1);
  });

  it('close all exits every leg at the live books, with exit fees counted', async () => {
    const r: any = await t.placeBasket(strangle());
    const c = await t.closeStrategy(r.basketId);
    expect(c.ok).toBe(true);
    const s = (await t.strategies()).closed[0]!;
    expect(s.closeReason).toBe('closed by you');
    expect(s.legs.every((l) => l.exit != null && l.fee > 0)).toBe(true);
    expect((await t.account()).positions).toHaveLength(0);
    expect((await t.closeStrategy(r.basketId)).ok).toBe(false); // already closed
    // the account's cash now equals the start balance plus the strategy's net pnl
    const a: any = await t.account();
    expect(a.account.cash).toBeCloseTo(10_000 + s.netPnl!, 6);
  });

  it('stops can be edited per leg, removed, and bad ones are refused', async () => {
    const r: any = await t.placeBasket(strangle());
    const put = sym('P', 76000);
    const entry = (await t.strategies()).open[0]!.legs.find((l) => l.symbol === put)!.entry;
    expect((await t.setStops(r.basketId, [{ symbol: put, stop: entry * 3 }])).ok).toBe(true);
    expect((await t.strategies()).open[0]!.legs.find((l) => l.symbol === put)!.stop).toBeCloseTo(entry * 3, 6);
    expect((await t.setStops(r.basketId, [{ symbol: put, stop: entry * 0.5 }])).ok).toBe(false); // a sold leg's stop must be above its entry
    expect((await t.setStops(r.basketId, [{ symbol: put, stop: null }])).ok).toBe(true);
    expect((await t.strategies()).open[0]!.legs.find((l) => l.symbol === put)!.stop).toBeNull();
    expect((await t.setStops(r.basketId, [{ symbol: sym('C', 80000), stop: 5 }])).ok).toBe(false);
  });

  it('bought legs have no stop unless asked, and an explicit stop must be below the fill', async () => {
    const bad: any = await t.placeBasket([{ symbol: sym('C', 80000), side: 'buy', lots: 10, stop: 99999 }]);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/needs its stop below/);
    const ok: any = await t.placeBasket([{ symbol: sym('C', 80000), side: 'buy', lots: 10 }, { symbol: sym('P', 80000), side: 'buy', lots: 10, stop: 100 }]);
    expect(ok.ok).toBe(true);
    const legs = (await t.strategies()).open[0]!.legs;
    expect(legs.find((l) => l.symbol === sym('C', 80000))!.stop).toBeNull();
    expect(legs.find((l) => l.symbol === sym('P', 80000))!.stop).toBe(100);
  });

  it('a bought leg stopped out closes the whole strategy too', async () => {
    await t.placeBasket([{ symbol: sym('C', 84000), side: 'sell', lots: 10, stop: null }, { symbol: sym('P', 80000), side: 'buy', lots: 10, stop: 150 }]);
    mk.bump.set(sym('P', 80000), -400); // the long put loses most of its value
    await t.tick();
    const s = await t.strategies();
    expect(s.open).toHaveLength(0);
    expect(s.closed[0]!.closeReason).toMatch(/stop: P-BTC-80000/);
  });

  it('a strategy rejected for margin or liquidity leaves no strategy record', async () => {
    mk.depth = 10;
    expect(((await t.placeBasket(strangle())) as any).ok).toBe(false);
    const s = await t.strategies();
    expect(s.open).toHaveLength(0);
    expect(s.closed).toHaveLength(0);
  });
});
