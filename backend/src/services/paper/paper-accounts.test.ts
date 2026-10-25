import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Instrument } from '../../lib/bot/paper-terminal.js';
import type { Book } from '../bot/delta-public.js';
import type { BoardRow, MarketProvider, MarketSnapshot } from './market.js';

/** Two people on one server: separate cash, positions, strategies, stops and resets over the same market. */
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
const STRIKES = [76000, 78000, 80000, 82000, 84000];
const mk = { px: 80_000, bump: new Map<string, number>() };
const timeValue = (k: number) => 500 * Math.exp(-(((k - 80_000) / 3000) ** 2)) + 5;
const markOf = (c: 'C' | 'P', k: number) => (c === 'C' ? Math.max(mk.px - k, 0) : Math.max(k - mk.px, 0)) + timeValue(k) + (mk.bump.get(sym(c, k)) ?? 0);
const perp: Instrument = { symbol: 'BTCUSD', kind: 'perp', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, premiumCapRate: 0, tick: 0.5, maxLeverage: 100 };
const inst = (c: 'C' | 'P', k: number): Instrument => ({ symbol: sym(c, k), kind: 'option', contractValue: 0.001, takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, tick: 0.1, maxLeverage: 1, option: { type: c === 'C' ? 'call' : 'put', strike: k, expiryMs: EXP, iv: 40 } });
function snapshot(): MarketSnapshot {
  const rows: BoardRow[] = []; const insts = new Map<string, Instrument>([['BTCUSD', perp]]);
  for (const k of STRIKES) for (const c of ['C', 'P'] as const) {
    const m = markOf(c, k);
    rows.push({ symbol: sym(c, k), type: c === 'C' ? 'call' : 'put', strike: k, expiryMs: EXP, bid: m - 5, ask: m + 5, bidSize: 1000, askSize: 1000, mark: m, iv: 40, delta: 0.3, gamma: 0, theta: 0, vega: 0, oi: 0, volume: 0, tick: 0.1 });
    insts.set(sym(c, k), inst(c, k));
  }
  return { at: Date.now(), spot: mk.px, perp: { symbol: 'BTCUSD', mark: mk.px, bid: mk.px - 0.5, ask: mk.px + 0.5, last: mk.px, funding: 0, oi: 0 }, rows, expiries: [EXP], insts };
}
const market: MarketProvider = {
  snapshot: async () => snapshot(),
  book: async (s: string): Promise<Book> => {
    if (s === 'BTCUSD') return { bids: [[mk.px - 0.5, 5000]], asks: [[mk.px + 0.5, 5000]] };
    const m = /^([CP])-BTC-(\d+)-/.exec(s)!; const x = markOf(m[1] as 'C' | 'P', Number(m[2]));
    return { bids: [[x - 5, 5000]], asks: [[x + 5, 5000]] };
  },
};

const ALICE = '00000000-0000-0000-0000-000000000001';
const BOB = '22222222-2222-2222-2222-222222222222';
let a: InstanceType<typeof PaperTerminal>, b: InstanceType<typeof PaperTerminal>;
const strangle = (lots = 100) => [{ symbol: sym('P', 78000), side: 'sell' as const, lots }, { symbol: sym('C', 82000), side: 'sell' as const, lots }];

beforeAll(async () => { h.db = new PGlite() as never; await ensurePaperSchema(); });
afterAll(() => undefined);
beforeEach(async () => {
  mk.px = 80_000; mk.bump.clear();
  a = new PaperTerminal(market, ALICE); b = new PaperTerminal(market, BOB);
  await a.reset(10_000); await b.reset(5_000);
});

describe('one paper account per person', () => {
  it('starts each person with their own cash and reset only touches their own account', async () => {
    expect(((await a.account()) as any).account.cash).toBe(10_000);
    expect(((await b.account()) as any).account.cash).toBe(5_000);
    await a.placeBasket(strangle());
    await b.placeBasket(strangle(50));
    await b.reset(7_000);
    expect(((await b.account()) as any).positions).toHaveLength(0);
    expect(((await b.account()) as any).account.cash).toBe(7_000);
    expect(((await a.account()) as any).positions).toHaveLength(2); // Alice is untouched
    expect((await a.strategies()).open).toHaveLength(1);
    expect((await b.strategies()).open).toHaveLength(0);
  });

  it('the same contract can be held by both with different sizes, and cash, fills, orders and strategies never mix', async () => {
    await a.placeBasket(strangle(100));
    await b.placeBasket(strangle(30));
    const pa = ((await a.account()) as any).positions, pb = ((await b.account()) as any).positions;
    expect(pa.find((p: any) => p.symbol === sym('P', 78000)).lots).toBe(-100);
    expect(pb.find((p: any) => p.symbol === sym('P', 78000)).lots).toBe(-30);
    expect((await a.fills(50)).length).toBe(2);
    expect((await b.fills(50)).length).toBe(2);
    expect((await a.orders(null, 50)).length).toBe(2);
    expect(((await a.account()) as any).account.cash).not.toBe(((await b.account()) as any).account.cash);
    expect((await a.pnl()).options.openCount).toBe(1);
    // neither can see or touch the other's strategy by its id
    const bobId = (await b.strategies()).open[0]!.id;
    expect((await a.closeStrategy(bobId)).ok).toBe(false);
    expect((await a.setStops(bobId, [{ symbol: sym('P', 78000), stop: 99999 }])).ok).toBe(false);
    expect((await b.strategies()).open).toHaveLength(1);
  });

  it('a stop closes only the strategy of the person whose leg hit it', async () => {
    await a.placeBasket(strangle(100));
    await b.placeBasket(strangle(100));
    // Bob widens his stops far away; Alice keeps the automatic 2x stop. The call becomes much dearer for both.
    const bobId = (await b.strategies()).open[0]!.id;
    await b.setStops(bobId, [{ symbol: sym('C', 82000), stop: 5000 }, { symbol: sym('P', 78000), stop: 5000 }]);
    mk.bump.set(sym('C', 82000), 1500);
    await a.tick();
    await b.tick();
    expect((await a.strategies()).open).toHaveLength(0);
    expect((await a.strategies()).closed[0]!.closeReason).toMatch(/stop:/);
    expect(((await a.account()) as any).positions).toHaveLength(0);
    expect((await b.strategies()).open).toHaveLength(1); // Bob's wider stop was not reached
    expect(((await b.account()) as any).positions).toHaveLength(2);
  });

  it('margin mode and the account row are per person too', async () => {
    await a.setMarginMode('standard');
    expect(((await a.account()) as any).marginMode).toBe('standard');
    expect(((await b.account()) as any).marginMode).toBe('portfolio');
    const rows = (await pool.query('SELECT account_id FROM paper_account ORDER BY account_id')).rows;
    expect(rows).toHaveLength(2);
  });
});
