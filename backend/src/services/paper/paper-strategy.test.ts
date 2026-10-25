import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Instrument } from '../../lib/bot/paper-terminal.js';
import type { Book } from '../bot/delta-public.js';
import type { BoardRow, MarketProvider, MarketSnapshot } from './market.js';

/** Multi-leg strategies and the margin-mode switch, on a scripted option board with real-looking strikes. */
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
const { pool } = await import('../../db/index.js');

const EXP = Date.now() + 2 * 86_400_000;
const ds = new Date(EXP).toISOString();
const DATE = `${ds.slice(8, 10)}${ds.slice(5, 7)}${ds.slice(2, 4)}`;
const sym = (c: 'C' | 'P', k: number) => `${c}-BTC-${k}-${DATE}`;
const STRIKES = [74000, 76000, 78000, 80000, 82000, 84000, 86000];
const mk = { px: 80_000, depth: 5000 };

const timeValue = (k: number) => 500 * Math.exp(-(((k - 80_000) / 3000) ** 2)) + 5;
const markOf = (c: 'C' | 'P', k: number) => (c === 'C' ? Math.max(mk.px - k, 0) : Math.max(k - mk.px, 0)) + timeValue(k);

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
  mk.px = 80_000; mk.depth = 5000;
  t = new PaperTerminal(market);
  await t.reset(10_000);
});

const condor = (lots: number) => [
  { symbol: sym('P', 76000), side: 'buy' as const, lots },
  { symbol: sym('P', 78000), side: 'sell' as const, lots },
  { symbol: sym('C', 82000), side: 'sell' as const, lots },
  { symbol: sym('C', 84000), side: 'buy' as const, lots },
];

describe('strategy builder', () => {
  it('previews an iron condor: credit, capped profit and loss, two breakevens, margin as one package', async () => {
    const p: any = await t.previewBasket(condor(100));
    expect(p.ok).toBe(true);
    expect(p.legs).toHaveLength(4);
    expect(p.netPremium).toBeGreaterThan(0); // a credit
    expect(p.payoff.maxProfit).toBeCloseTo(p.netPremium, 6);
    expect(p.payoff.maxLoss).toBeCloseTo(p.netPremium - 200, 6); // 2000-wide wings x 100 lots x 0.001
    expect(p.payoff.breakevens).toHaveLength(2);
    expect(p.marginMode).toBe('portfolio');
    expect(p.marginAfter).toBeLessThan(260);
    expect((await t.orders(null, 10))).toHaveLength(0); // nothing placed
  });

  it('places every leg together as market orders linked by one basket id', async () => {
    const r: any = await t.placeBasket(condor(100));
    expect(r.ok).toBe(true);
    expect(r.orders).toHaveLength(4);
    expect(new Set(r.orders.map((o: any) => o.basketId)).size).toBe(1);
    const a = await t.account();
    expect(a.positions).toHaveLength(4);
    expect(a.positions.find((p: any) => p.symbol === sym("P", 78000))!.lots).toBe(-100);
    expect(a.positions.find((p: any) => p.symbol === sym("C", 84000))!.lots).toBe(100);
    const hist = await t.orders('filled', 10);
    expect(hist.every((o) => o.basketId === r.basketId && o.status === 'filled')).toBe(true);
  });

  it('is all or nothing: a leg the book cannot fill rejects the whole strategy', async () => {
    mk.depth = 40;
    const r: any = await t.placeBasket(condor(100));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot be filled at once/);
    expect((await t.account()).positions).toHaveLength(0);
  });

  it('rejects an unknown contract and bad leg counts', async () => {
    expect(((await t.previewBasket([{ symbol: 'C-BTC-1-010125', side: 'buy', lots: 1 }])) as any).reason).toMatch(/not listed/);
    expect(((await t.previewBasket([])) as any).reason).toMatch(/1 and 8 legs/);
  });

  it('a long straddle shows unlimited profit and a capped loss', async () => {
    const p: any = await t.previewBasket([{ symbol: sym('C', 80000), side: 'buy', lots: 100 }, { symbol: sym('P', 80000), side: 'buy', lots: 100 }]);
    expect(p.ok).toBe(true);
    expect(p.payoff.maxProfit).toBeNull();
    expect(p.payoff.maxLoss).toBeCloseTo(p.netPremium, 6);
    expect(p.netPremium).toBeLessThan(0); // a debit
  });
});

describe('margin mode: portfolio versus standard', () => {
  it('a hedged condor needs far less margin in portfolio mode than in standard mode', async () => {
    const port: any = await t.previewBasket(condor(100));
    expect((await t.setMarginMode('standard')).ok).toBe(true);
    const std: any = await t.previewBasket(condor(100));
    expect(std.marginMode).toBe('standard');
    expect(std.marginAfter).toBeGreaterThan(port.marginAfter * 4);
    expect((await t.account() as any).marginMode).toBe('standard');
  });

  it('a strategy that fits under portfolio margin is refused in standard mode when equity is small', async () => {
    await t.reset(1500);
    expect(((await t.previewBasket(condor(100))) as any).ok).toBe(true);
    await t.setMarginMode('standard');
    const r: any = await t.placeBasket(condor(100));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/insufficient margin: standard margin/);
  });

  it('cannot switch to a mode the open positions would not survive', async () => {
    await t.reset(1500);
    expect(((await t.placeBasket(condor(100))) as any).ok).toBe(true);
    const sw = await t.setMarginMode('standard');
    expect(sw.ok).toBe(false);
    expect((sw as any).reason).toMatch(/Close some positions first/);
    expect(((await t.account()) as any).marginMode).toBe('portfolio');
  });

  it('a naked short call is margined on its own in standard mode', async () => {
    await t.setMarginMode('standard');
    await t.place({ symbol: sym('C', 84000), side: 'sell', type: 'market', lots: 100 });
    const a: any = await t.account();
    // 100 lots x 0.001 x (mark + max(0.15 x 80000 - 4000, 0.1 x 80000)) = 0.1 x (mark + 8000)
    expect(a.view.optionMargin).toBeGreaterThan(800);
    expect(a.view.optionMargin).toBeLessThan(900);
  });

  it('reset returns the account to portfolio mode', async () => {
    await t.setMarginMode('standard');
    await t.reset(10_000);
    expect(((await t.account()) as any).marginMode).toBe('portfolio');
  });
});

describe('estimated margin on the chain and in the ticket preview', () => {
  it('every strike carries the extra margin for selling the chosen size, in the account\'s margin mode', async () => {
    const b = await t.boardWithMargin(100);
    const row = b.rows.find((r) => r.symbol === sym('C', 84000))!;
    expect(row.sellMargin).toBeGreaterThan(0);
    expect(row.sellOk).toBe(true);
    expect(row.buyCost).toBeCloseTo(row.ask * 100 * 0.001, 6);
    await t.setMarginMode('standard');
    const s = (await t.boardWithMargin(100)).rows.find((r) => r.symbol === sym('C', 84000))!;
    expect(s.sellMargin!).toBeGreaterThan(row.sellMargin! * 0.9);
    expect(s.sellMargin).toBeGreaterThan(800);
    expect((await t.boardWithMargin(1000)).rows.find((r) => r.symbol === sym('C', 84000))!.sellMargin!).toBeGreaterThan(s.sellMargin! * 5);
  });

  it('flags a sale the account cannot carry', async () => {
    await t.reset(300);
    await t.setMarginMode('standard');
    const row = (await t.boardWithMargin(100)).rows.find((r) => r.symbol === sym('C', 84000))!;
    expect(row.sellOk).toBe(false);
  });

  it('a hedged sale shows a smaller extra margin than a naked one (portfolio mode nets the legs)', async () => {
    await t.reset(200_000);
    const naked = (await t.boardWithMargin(3000)).rows.find((r) => r.symbol === sym('C', 82000))!.sellMargin!;
    await t.place({ symbol: sym('C', 84000), side: 'buy', type: 'market', lots: 3000 });
    const hedged = (await t.boardWithMargin(3000)).rows.find((r) => r.symbol === sym('C', 82000))!.sellMargin!;
    expect(hedged).toBeLessThan(naked);
  });

  it('the ticket preview reports the margin THIS order needs and the premium it receives, even for a resting limit order', async () => {
    const p: any = await t.preview({ symbol: sym('C', 84000), side: 'sell', type: 'market', lots: 100 });
    expect(p.ok).toBe(true);
    expect(p.marginRequired).toBeGreaterThan(0);
    expect(p.marginRequired).toBeCloseTo(p.marginAfter - p.marginBefore, 6);
    expect(p.premium).toBeGreaterThan(0);
    const rest: any = await t.preview({ symbol: sym('C', 84000), side: 'sell', type: 'limit', lots: 100, price: 9999 });
    expect(rest.fills).toBe(0);
    expect(rest.resting).toBe(true);
    expect(rest.marginRequired).toBeGreaterThan(0);
  });
});
