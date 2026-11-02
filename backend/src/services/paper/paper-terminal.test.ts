import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Instrument } from '../../lib/bot/paper-terminal.js';
import type { Book } from '../bot/delta-public.js';
import type { BoardRow, MarketProvider, MarketSnapshot } from './market.js';

/** The paper terminal on a real Postgres (PGlite) with a scripted market. */
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
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params as never)).rows as any[];

const EXP = Date.now() + 2 * 86_400_000;
const CALL = `C-BTC-82000-${new Date(EXP).toISOString().slice(8, 10)}${new Date(EXP).toISOString().slice(5, 7)}${new Date(EXP).toISOString().slice(2, 4)}`;

const mk = { px: 80_000, callMark: 300, depth: 500, twoExpiries: false, dropCall: false };
const EXP2 = EXP + 86_400_000;
const PUT2 = `P-BTC-78000-${new Date(EXP2).toISOString().slice(8, 10)}${new Date(EXP2).toISOString().slice(5, 7)}${new Date(EXP2).toISOString().slice(2, 4)}`;

const perpInst: Instrument = { symbol: 'BTCUSD', kind: 'perp', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, premiumCapRate: 0, tick: 0.5, maxLeverage: 100 };
const callInst = (): Instrument => ({
  symbol: CALL, kind: 'option', contractValue: 0.001, takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, tick: 5, maxLeverage: 1,
  option: { type: 'call', strike: 82000, expiryMs: EXP, iv: 40 },
});

function snapshot(): MarketSnapshot {
  const row: BoardRow = { symbol: CALL, type: 'call', strike: 82000, expiryMs: EXP, bid: mk.callMark - 10, ask: mk.callMark + 10, bidSize: 100, askSize: 100, mark: mk.callMark, iv: 40, delta: 0.3, gamma: 0, theta: 0, vega: 0, oi: 0, volume: 0, tick: 5 };
  const snap: MarketSnapshot = {
    at: Date.now(), spot: mk.px, perp: { symbol: 'BTCUSD', mark: mk.px, bid: mk.px - 0.5, ask: mk.px + 0.5, last: mk.px, funding: 0, oi: 0 },
    rows: [row], expiries: [EXP], insts: new Map([['BTCUSD', perpInst], [CALL, callInst()]]),
  };
  const out = snap;
  if (mk.dropCall) out.rows = [];
  if (mk.twoExpiries) {
    out.rows.push({ ...row, symbol: PUT2, type: 'put', strike: 78000, expiryMs: EXP2, delta: -0.2 });
    out.expiries = [EXP, EXP2];
    out.insts.set(PUT2, { ...callInst(), symbol: PUT2, option: { type: 'put', strike: 78000, expiryMs: EXP2, iv: 40 } });
  }
  return out;
}

const market: MarketProvider = {
  snapshot: async () => snapshot(),
  book: async (symbol: string): Promise<Book> => {
    if (symbol === 'BTCUSD') return { bids: [[mk.px - 0.5, 50], [mk.px - 5, mk.depth]], asks: [[mk.px + 0.5, 50], [mk.px + 5, mk.depth]] };
    return { bids: [[mk.callMark - 10, 100], [mk.callMark - 20, 100]], asks: [[mk.callMark + 10, 100], [mk.callMark + 20, 100]] };
  },
};

let t: InstanceType<typeof PaperTerminal>;

beforeAll(async () => {
  process.env.PAPER_START_USD = '10000';
  h.db = new PGlite() as never;
  await ensurePaperSchema();
});
afterAll(() => undefined);
beforeEach(async () => {
  mk.px = 80_000; mk.callMark = 300; mk.depth = 500; mk.twoExpiries = false; mk.dropCall = false;
  t = new PaperTerminal(market);
  await t.reset(10_000);
});

describe('market orders', () => {
  it('a perpetual market buy walks the real book, charges the taker fee and opens a margined position', async () => {
    await t.setMarginMode('standard'); // per-position leverage is a standard-margin idea
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 100, leverage: 10 });
    expect(r.order.status).toBe('filled');
    // 50 lots at the best ask, 50 at the next level
    expect(r.order.avgPrice).toBeCloseTo((50 * 80_000.5 + 50 * 80_005) / 100, 6);
    const a = await t.account();
    expect(a.positions[0]).toMatchObject({ symbol: 'BTCUSD', lots: 100, leverage: 10 });
    const fee = 0.0005 * r.order.avgPrice! * 100 * 0.001 * 1.18;
    expect(a.account.cash).toBeCloseTo(10_000 - fee, 6);
    expect(a.view!.perpMargin).toBeCloseTo((100 * 0.001 * 80_000) / 10, 4);
    const fills = await t.fills(10);
    expect(fills[0]!.slippageUsd).toBeCloseTo(Math.abs(r.order.avgPrice! - 80_000.5) * 100 * 0.001, 6);
    expect(fills[0]!.maker).toBe(false);
  });

  it('portfolio margin ignores the leverage picked: a BTC future needs value / 90.3 and reports that effective leverage', async () => {
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 100, leverage: 10 });
    expect(r.order.status).toBe('filled');
    const a: any = await t.account();
    const value = 100 * 0.001 * 80_000;
    expect(a.view.margin).toBeCloseTo(value / 90.3, 1);
    expect(a.positions[0].leverage).toBeCloseTo(90.3, 0);
    expect(a.positions[0].margin).toBeCloseTo(value / 90.3, 1);
    const p: any = await t.preview({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 100, leverage: 3 });
    expect(p.marginRequired).toBeCloseTo((100 * 0.001 * 80_000.5) / 90.3, 0);
  });

  it('closing at a higher price realises the profit into cash', async () => {
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 50, leverage: 10 });
    mk.px = 81_000;
    const r = await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'market', lots: 50, reduceOnly: true });
    expect(r.order.status).toBe('filled');
    const a = await t.account();
    expect(a.positions).toHaveLength(0);
    // bought 50 @ 80000.5, sold 50 @ 80999.5 => 49.95 gross, less two taker fees
    expect(a.account.realizedTotal).toBeCloseTo(50 * 0.001 * (80_999.5 - 80_000.5), 6);
    expect(a.account.cash).toBeGreaterThan(10_000 + 40);
    expect(a.account.cash).toBeLessThan(10_000 + 50);
  });

  it('rejects an order the margin cannot carry, with the reason', async () => {
    await t.setMarginMode('standard'); // per-position leverage is a standard-margin idea
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 5000, leverage: 2 });
    expect(r.order.status).toBe('rejected');
    expect(r.order.reason).toMatch(/insufficient margin/);
    expect((await t.account()).positions).toHaveLength(0);
  });

  it('a market order larger than the book fills what is there and cancels the rest', async () => {
    mk.depth = 20;
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 200, leverage: 20 });
    expect(r.order.filledLots).toBe(70);
    expect(r.order.status).toBe('cancelled');
    expect(r.order.reason).toMatch(/book depth/);
  });

  it('reduce-only is clamped to the position size and refused without one', async () => {
    const none = await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'market', lots: 5, reduceOnly: true });
    expect(none.order.status).toBe('rejected');
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 10, leverage: 10 });
    const big = await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'market', lots: 50, reduceOnly: true });
    expect(big.order.lots).toBe(10);
    expect((await t.account()).positions).toHaveLength(0);
  });
});

describe('resting orders', () => {
  it('a limit buy below the market rests, then fills as maker at its price only when the market trades through it', async () => {
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'limit', lots: 10, price: 79_900, leverage: 10 });
    expect(r.order.status).toBe('working');
    await t.tick();
    expect((await t.account()).positions).toHaveLength(0);
    mk.px = 79_901; // ask 79901.5, still above the limit
    await t.tick();
    expect((await t.account()).positions).toHaveLength(0);
    mk.px = 79_890; // ask 79890.5 < 79900: traded through
    await t.tick();
    const a = await t.account();
    expect(a.positions[0]).toMatchObject({ lots: 10, avgEntry: 79_900 });
    const f = (await t.fills(5))[0]!;
    expect(f.maker).toBe(true);
    expect(f.fee).toBeCloseTo(0.0002 * 79_900 * 10 * 0.001 * 1.18, 6);
  });

  it('a marketable limit fills the crossing part now and rests the remainder', async () => {
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'limit', lots: 80, price: 80_001, leverage: 10 });
    expect(r.order.filledLots).toBe(50); // only the 80000.5 level is within the limit
    expect(r.order.status).toBe('working');
  });

  it('a stop-market sell triggers on the mark and closes the position', async () => {
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 20, leverage: 10 });
    const s = await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'stop_market', lots: 20, stopPrice: 79_500, reduceOnly: true });
    expect(s.order.status).toBe('working');
    mk.px = 79_800;
    await t.tick();
    expect((await t.account()).positions).toHaveLength(1);
    mk.px = 79_400;
    await t.tick();
    expect((await t.account()).positions).toHaveLength(0);
    expect((await t.orders('filled', 10)).some((o) => o.type === 'stop_market')).toBe(true);
  });

  it('refuses a stop that would trigger immediately', async () => {
    const r = await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'stop_market', lots: 5, stopPrice: 80_500 });
    expect(r.order.status).toBe('rejected');
    expect(r.order.reason).toMatch(/trigger immediately/);
  });

  it('a bracket places take-profit and stop-loss; when one fills the other is cancelled', async () => {
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 20, leverage: 10, takeProfit: 80_500, stopLoss: 79_500 });
    expect(r.children).toHaveLength(2);
    expect((await t.orders('working', 10)).length).toBe(2);
    mk.px = 80_600; // TP limit sell at 80500 trades through: bid 80599.5 > 80500
    await t.tick();
    const a = await t.account();
    expect(a.positions).toHaveLength(0);
    const all = await t.orders(null, 20);
    expect(all.filter((o) => o.reduceOnly).map((o) => o.status).sort()).toEqual(['cancelled', 'filled']);
    expect(all.find((o) => o.status === 'cancelled' && o.reduceOnly)!.reason).toMatch(/bracket partner/);
  });

  it('rejects a bracket on the wrong side of the market', async () => {
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 5, takeProfit: 79_000 });
    expect(r.order.status).toBe('rejected');
    expect(r.order.reason).toMatch(/take-profit/);
    expect((await t.account()).positions).toHaveLength(0);
  });

  it('cancel and cancel-all work, and cancelling one bracket leg cancels its partner', async () => {
    const a = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'limit', lots: 5, price: 79_000, leverage: 5 });
    expect(await t.cancel(a.order.id)).toBe(true);
    expect(await t.cancel(a.order.id)).toBe(false);
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 10, leverage: 10, takeProfit: 81_000, stopLoss: 79_000 });
    const [first] = await t.orders('working', 5);
    await t.cancel(first!.id);
    expect(await t.orders('working', 5)).toHaveLength(0);
  });
});

describe('options', () => {
  it('buying a call pays the premium from cash; the position is an asset at mark', async () => {
    const r = await t.place({ symbol: CALL, side: 'buy', type: 'market', lots: 100 });
    expect(r.order.status).toBe('filled');
    const a = await t.account();
    const premium = 310 * 100 * 0.001;
    expect(a.account.cash).toBeLessThan(10_000 - premium + 0.01);
    expect(a.account.cash).toBeGreaterThan(10_000 - premium - 2);
    expect(a.view!.optionsValue).toBeCloseTo(300 * 100 * 0.001, 6);
    expect(a.view!.equity).toBeCloseTo(10_000 - (310 - 300) * 100 * 0.001 - (10_000 - premium - a.account.cash), 4);
  });

  it('selling a call credits the premium and needs portfolio margin', async () => {
    const r = await t.place({ symbol: CALL, side: 'sell', type: 'market', lots: 100 });
    expect(r.order.status).toBe('filled');
    const a = await t.account();
    expect(a.account.cash).toBeGreaterThan(10_000);
    expect(a.view!.optionMargin).toBeGreaterThan(0);
    expect(a.view!.margin).toBeLessThan(a.view!.equity);
  });

  it('cannot buy more premium than the cash covers', async () => {
    mk.callMark = 50_000; // 200 lots would cost about $10,003 in premium against $10,000 of cash
    const r = await t.place({ symbol: CALL, side: 'buy', type: 'market', lots: 200 });
    expect(r.order.status).toBe('rejected');
    expect(r.order.reason).toMatch(/not enough cash|insufficient margin/);
    expect((await t.account()).positions).toHaveLength(0);
  });

  it('an expired option is cash-settled at intrinsic value', async () => {
    await t.place({ symbol: CALL, side: 'buy', type: 'market', lots: 100 });
    // move the contract into the past: the symbol's date becomes yesterday, and BTC finished above the strike
    const past = new Date(Date.now() - 86_400_000);
    const sym = `C-BTC-82000-${String(past.getUTCDate()).padStart(2, '0')}${String(past.getUTCMonth() + 1).padStart(2, '0')}${String(past.getUTCFullYear()).slice(2)}`;
    await pool.query('UPDATE paper_positions SET symbol = $1', [sym]);
    mk.px = 83_000;
    const before = (await t.account()).account.cash;
    await t.tick();
    const a = await t.account();
    expect(a.positions).toHaveLength(0);
    expect(a.account.cash).toBeCloseTo(before + 1000 * 100 * 0.001, 6);
    expect((await t.fills(3))[0]!.note).toMatch(/expiry settlement/);
  });
});

describe('risk', () => {
  it('liquidates everything when equity falls below half the margin', async () => {
    mk.depth = 5000;
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 1000, leverage: 50 });
    await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'limit', lots: 1, price: 90_000, reduceOnly: true }); // a resting order to be cancelled
    mk.px = 79_000; // -1000 x 1 BTC... 1000 lots = 1 BTC: a $1000 loss on $10k with $1600 margin
    await t.tick();
    expect((await t.account()).positions).toHaveLength(1);
    mk.px = 70_000; // -$10k: equity is gone
    await t.tick();
    const a = await t.account();
    expect(a.positions).toHaveLength(0);
    expect(await t.orders('working', 5)).toHaveLength(0);
    expect((await t.fills(3)).some((f) => /liquidation/.test(f.note ?? ''))).toBe(true);
  });

  it('leverage can be changed on the perpetual, within limits, and only if the margin holds', async () => {
    await t.setMarginMode('standard'); // per-position leverage is a standard-margin idea
    expect((await t.setLeverage('BTCUSD', 500)).ok).toBe(false);
    expect((await t.setLeverage(CALL, 5)).ok).toBe(false);
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 100, leverage: 20 });
    expect((await t.setLeverage('BTCUSD', 40)).ok).toBe(true);
    expect((await t.account()).positions[0]!.leverage).toBe(40);
  });

  it('preview estimates the fill without placing anything', async () => {
    await t.setMarginMode('standard'); // per-position leverage is a standard-margin idea
    const p = await t.preview({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 100, leverage: 10 });
    expect(p).toMatchObject({ ok: true, fills: 100 });
    expect((p as any).fee).toBeGreaterThan(0);
    expect((p as any).marginAfter).toBeCloseTo((100 * 0.001 * 80_000) / 10, 0);
    expect(await t.orders(null, 10)).toHaveLength(0);
    expect((await t.preview({ symbol: 'NOPE', side: 'buy', type: 'market', lots: 1 })).ok).toBe(false);
  });

  it('reset wipes the account back to the chosen balance', async () => {
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 10, leverage: 10 });
    await t.reset(25_000);
    const a = await t.account();
    expect(a.account).toMatchObject({ cash: 25_000, startBalance: 25_000, realizedTotal: 0, feesTotal: 0 });
    expect(a.positions).toHaveLength(0);
    expect(await q('SELECT 1 FROM paper_fills')).toHaveLength(0);
  });
});

describe('board margin', () => {
  it('computes margin only for the asked expiry', async () => {
    mk.twoExpiries = true;
    const b = await t.boardWithMargin(100, EXP2);
    expect(b.expiry).toBe(EXP2);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.rows.every((r) => r.expiryMs === EXP2)).toBe(true);
  });
  it('falls back to the first expiry when none or an unknown one is asked', async () => {
    mk.twoExpiries = true;
    expect((await t.boardWithMargin(100)).expiry).toBe(EXP);
    expect((await t.boardWithMargin(100, 123)).expiry).toBe(EXP);
  });
  it('serves a repeat call from cache and drops the cache after a trade', async () => {
    const spy = vi.spyOn(t as any, 'view');
    await t.boardWithMargin(100, EXP);
    const n = spy.mock.calls.length;
    await t.boardWithMargin(100, EXP);
    expect(spy.mock.calls.length).toBe(n);
    await t.place({ symbol: CALL, side: 'sell', type: 'market', lots: 10 });
    const before = spy.mock.calls.length;
    await t.boardWithMargin(100, EXP);
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('board margin cache race', () => {
  it('a board read that overlaps a trade is not cached as the post-trade answer', async () => {
    // the board's load() returns the pre-trade state, and a whole trade lands before the board finishes
    const real = (t as any).load.bind(t);
    let armed = true;
    vi.spyOn(t as any, 'load').mockImplementation(async () => {
      if (!armed) return real();
      armed = false;
      const old = await real();
      await t.place({ symbol: CALL, side: 'sell', type: 'market', lots: 10 });
      return old;
    });
    await t.boardWithMargin(100, EXP);
    const after = await t.boardWithMargin(100, EXP);
    const view = (await t.account()).view!;
    expect(after.available).toBeCloseTo(view.available, 6);
  });
});

describe('paper pnl', () => {
  it('futures open net is unrealised minus the fees of the open position', async () => {
    const r = await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 100 });
    mk.px = 80_500;
    const a = await t.account();
    const upnl = a.positions.find((x: any) => x.symbol === 'BTCUSD')!.unrealized!;
    const p = await t.pnl();
    expect(p.futures.openFees).toBeCloseTo(r.order.fee!, 6);
    expect(p.futures.openPnl).toBeCloseTo(upnl, 6);
    expect(p.futures.openNet).toBeCloseTo(upnl - r.order.fee!, 6);
  });
  it('futures open fees count only fills since the position was last flat', async () => {
    await t.place({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 10 });
    await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'market', lots: 10 });
    const r = await t.place({ symbol: 'BTCUSD', side: 'sell', type: 'market', lots: 20 });
    expect((await t.pnl()).futures.openFees).toBeCloseTo(r.order.fee!, 6);
  });
  it('open pnl is null, not zero, when a mark is missing', async () => {
    await t.place({ symbol: CALL, side: 'buy', type: 'market', lots: 10 });
    mk.dropCall = true; // the call drops out of the chain, so it has no quote
    const p = await t.pnl();
    expect(p.options.openPnl).toBeNull();
    expect(p.options.openNet).toBeNull();
    expect(p.options.openKnown).toBe(false);
  });
  it('pnl reuses a given account instead of computing it again', async () => {
    const a = await t.account();
    const spy = vi.spyOn(t, 'account');
    await t.pnl(a);
    expect(spy).not.toHaveBeenCalled();
  });
  it('account carries the perpetual contract info', async () => {
    expect((await t.account()).perpInfo?.maxLeverage).toBe(100);
  });
});
