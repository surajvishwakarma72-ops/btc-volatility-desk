import { describe, expect, it } from 'vitest';
import { buildClosingOrders, LiveExit, OPTION_SYMBOL, type LiveExitDeps, type OptionPosition } from './live-exit.js';
import type { Book } from '../bot/delta-public.js';

const EXP = '261027';
const C = `C-BTC-82000-${EXP}`, P = `P-BTC-78000-${EXP}`, WING = `C-BTC-86000-${EXP}`, OTHER = 'C-BTC-90000-261103';
const pos = (symbol: string, size: number, productId = 1): OptionPosition => ({ productId, symbol, size, entry: 100 });
const book = (bid: number, ask: number): Book => ({ bids: [[bid, 500]], asks: [[ask, 500]] });
const books = new Map<string, Book>([[C, book(180, 183)], [P, book(150, 154)], [WING, book(10, 12)], [OTHER, book(50, 52)]]);
const tick = () => 0.5;

describe('closing orders: only ever reduce-only, immediate-or-cancel, closing', () => {
  const positions = [pos(WING, 100, 3), pos(C, -100, 1), pos(P, -100, 2), pos(OTHER, -50, 4), { productId: 9, symbol: 'BTCUSD', size: 10, entry: 80000 }, pos(`C-BTC-80000-${EXP}`, 0, 5)];
  const { orders, problems } = buildClosingOrders(positions, books, tick, EXP);

  it('closes both legs and the long wing in this expiry only, shorts first, and ignores other expiries, futures and empty positions', () => {
    expect(orders.map((o) => o.symbol)).toEqual([C, P, WING]);
    expect(problems).toEqual([]);
  });
  it('buys back a short above the ask and sells a long below the bid, on the tick', () => {
    const c = orders[0]!, w = orders[2]!;
    expect(c.side).toBe('buy');
    expect(c.size).toBe(100);
    expect(c.limitPrice).toBeGreaterThan(183);
    expect(c.limitPrice % 0.5).toBeCloseTo(0, 9);
    expect(c.limitPrice).toBeLessThan(183 * 1.1); // a bounded buffer, not an open cheque
    expect(w.side).toBe('sell');
    expect(w.limitPrice).toBeLessThan(10 + 0.0001);
    expect(w.limitPrice).toBeGreaterThan(0);
  });
  it('every payload is a reduce-only immediate-or-cancel limit order with Delta\'s field names', () => {
    for (const o of orders) {
      expect(o.payload).toEqual({ product_id: o.productId, size: o.size, side: o.side, order_type: 'limit_order', limit_price: String(o.limitPrice), time_in_force: 'ioc', reduce_only: true });
      expect(Number.isInteger(o.payload.size) && o.payload.size > 0).toBe(true);
    }
  });
  it('a retry reaches further past the best price, and never past a sane bound', () => {
    const a0 = buildClosingOrders([pos(C, -100)], books, tick, EXP, 0).orders[0]!.limitPrice;
    const a1 = buildClosingOrders([pos(C, -100)], books, tick, EXP, 1).orders[0]!.limitPrice;
    const a2 = buildClosingOrders([pos(C, -100)], books, tick, EXP, 2).orders[0]!.limitPrice;
    expect(a1).toBeGreaterThan(a0);
    expect(a2).toBeGreaterThan(a1);
    expect(a2).toBeLessThan(183 * 1.5);
  });
  it('reports a leg with no price in the book instead of guessing one', () => {
    const r = buildClosingOrders([pos(C, -100), pos(P, -100)], new Map([[C, book(180, 183)], [P, { bids: [[150, 1]], asks: [] }]]), tick, EXP);
    expect(r.orders.map((o) => o.symbol)).toEqual([C]);
    expect(r.problems[0]).toMatch(/P-BTC-78000.*no ask/);
  });
  it('only BTC option symbols are ever accepted', () => {
    expect(OPTION_SYMBOL.test(C)).toBe(true);
    for (const s of ['BTCUSD', 'ETH-USD', 'C-ETH-3000-261027', 'C-BTC-82000-27102', "C-BTC-1-261027'; DROP"]) expect(OPTION_SYMBOL.test(s), s).toBe(false);
  });
});

function harness(over: Partial<{ live: boolean; key: boolean; positions: Array<OptionPosition[]>; failPositions: boolean; rejectAll: boolean }> = {}) {
  const log: Array<{ kind: string; detail: string; dryRun: boolean }> = [];
  const posts: any[] = [];
  let t = 1_000_000;
  const rounds = over.positions ?? [[pos(C, -100, 1), pos(P, -100, 2)], []];
  let read = 0;
  const d: LiveExitDeps = {
    liveEnabled: () => over.live ?? true,
    tradeKey: async () => (over.key === false ? null : { key: 'k', secret: 's' }),
    positions: async () => { if (over.failPositions) throw new Error('Delta refused the positions request (ip_not_whitelisted)'); const r = rounds[Math.min(read, rounds.length - 1)]!; read++; return r; },
    book: async (s) => books.get(s) ?? { bids: [], asks: [] },
    tickOf: tick,
    post: async (_k, _s, payload) => { posts.push(payload); return over.rejectAll ? { ok: false, status: 400, body: null, errorText: 'insufficient_margin' } : { ok: true, status: 200, body: { success: true }, errorText: '' }; },
    log: async (_u, kind, detail, o) => { log.push({ kind, detail, dryRun: o.dryRun }); },
    sleep: async () => { t += 1500; },
    now: () => t,
  };
  return { d, log, posts, advance: (ms: number) => { t += ms; } };
}
const group = { id: EXP, label: 'Delta · 27 Oct expiry', legs: [{ symbol: C, side: 'sold' as const, lots: 100, entry: 100, mark: 196, stop: 200, pointsLeft: 4, level: 'hard' as const }, { symbol: P, side: 'sold' as const, lots: 100, entry: 120, mark: 130, stop: 240, pointsLeft: 110, level: 'safe' as const }] };

describe('live exit: the locks', () => {
  it('sends nothing and says why when it is not armed', async () => {
    const h = harness();
    expect(await new LiveExit(h.d).run('u', group, { liveArmed: false, dryRun: false })).toBe('blocked');
    expect(h.posts).toHaveLength(0);
    expect(h.log[0]).toMatchObject({ kind: 'hard_exit_blocked', dryRun: true });
    expect(h.log[0]!.detail).toMatch(/not armed.*Alarm only/);
  });
  it('sends nothing when dry-run is off but the server switch is not set', async () => {
    const h = harness({ live: false });
    expect(await new LiveExit(h.d).run('u', group, { liveArmed: true, dryRun: false })).toBe('blocked');
    expect(h.posts).toHaveLength(0);
    expect(h.log[0]!.detail).toMatch(/LIVE_TRADING_ENABLED/);
  });
  it('sends nothing without a saved trading key', async () => {
    const h = harness({ key: false });
    expect(await new LiveExit(h.d).run('u', group, { liveArmed: true, dryRun: false })).toBe('blocked');
    expect(h.posts).toHaveLength(0);
    expect(h.log[0]!.detail).toMatch(/no trading key/);
  });
  it('does not repeat the "blocked" note every few seconds', async () => {
    const h = harness();
    const x = new LiveExit(h.d);
    for (let i = 0; i < 5; i++) { await x.run('u', group, { liveArmed: false, dryRun: true }); h.advance(5000); }
    expect(h.log.filter((l) => l.kind === 'hard_exit_blocked')).toHaveLength(1);
  });
  it('dry-run (the default) writes what it would send and sends nothing, even with the server switch on', async () => {
    const h = harness();
    expect(await new LiveExit(h.d).run('u', group, { liveArmed: true, dryRun: true })).toBe('dry');
    expect(h.posts).toHaveLength(0);
    const dry = h.log.filter((l) => l.kind === 'hard_exit_dry');
    expect(dry).toHaveLength(2);
    expect(dry[0]!.detail).toMatch(/DRY RUN, nothing sent: would buy 100 C-BTC-82000-261027 at limit/);
    expect(dry.every((l) => l.dryRun)).toBe(true);
  });
});

describe('live exit: real orders (armed, key saved, dry-run off, server switch on)', () => {
  const live = { liveArmed: true, dryRun: false };
  it('sends one reduce-only order per leg, checks the positions, and reports done', async () => {
    const h = harness();
    expect(await new LiveExit(h.d).run('u', group, live)).toBe('done');
    expect(h.posts).toHaveLength(2);
    expect(h.posts.map((p) => p.product_id)).toEqual([1, 2]);
    for (const p of h.posts) expect(p).toMatchObject({ side: 'buy', size: 100, order_type: 'limit_order', time_in_force: 'ioc', reduce_only: true });
    expect(h.log.some((l) => l.kind === 'hard_exit_done' && !l.dryRun)).toBe(true);
    expect(h.log.some((l) => /accepted by Delta/.test(l.detail))).toBe(true);
  });
  it('tries again at a wider price when the position is still open, and gives up loudly after three tries', async () => {
    const still = [pos(C, -100, 1), pos(P, -100, 2)];
    const h = harness({ positions: [still, still, still, still, still, still, still, still] });
    expect(await new LiveExit(h.d).run('u', group, live)).toBe('incomplete');
    expect(h.posts).toHaveLength(6); // two legs, three tries
    const cLimits = h.posts.filter((p) => p.product_id === 1).map((p) => Number(p.limit_price));
    expect(cLimits[1]).toBeGreaterThan(cLimits[0]!);
    expect(cLimits[2]).toBeGreaterThan(cLimits[1]!);
    expect(h.log.pop()!.detail).toMatch(/still open after 3 tries. Close them on Delta now/);
  });
  it('logs a rejection and does not throw', async () => {
    const still = [pos(C, -100, 1)];
    const h = harness({ positions: [still, still, still, still, still, still, still], rejectAll: true });
    expect(await new LiveExit(h.d).run('u', group, live)).toBe('incomplete');
    expect(h.log.some((l) => l.kind === 'hard_exit_failed' && /rejected: insufficient_margin/.test(l.detail))).toBe(true);
  });
  it('does nothing when there is nothing left to close', async () => {
    const h = harness({ positions: [[]] });
    expect(await new LiveExit(h.d).run('u', group, live)).toBe('flat');
    expect(h.posts).toHaveLength(0);
  });
  it('stops and says so when Delta cannot be read, and never sends a blind order', async () => {
    const h = harness({ failPositions: true });
    expect(await new LiveExit(h.d).run('u', group, live)).toBe('failed');
    expect(h.posts).toHaveLength(0);
    expect(h.log.pop()!.detail).toMatch(/ip_not_whitelisted.*Close it on Delta now/);
  });
  it('waits 45 seconds before another round on the same position, and gives up after three rounds', async () => {
    const still = [pos(C, -100, 1)];
    const h = harness({ positions: Array.from({ length: 40 }, () => still) });
    const x = new LiveExit(h.d);
    expect(await x.run('u', group, live)).toBe('incomplete');
    const sent = h.posts.length;
    expect(await x.run('u', group, live)).toBe('cooldown');
    expect(h.posts.length).toBe(sent);
    h.advance(50_000);
    expect(await x.run('u', group, live)).toBe('incomplete');
    h.advance(50_000);
    expect(await x.run('u', group, live)).toBe('incomplete'); // third round
    h.advance(50_000);
    expect(await x.run('u', group, live)).toBe('cooldown'); // no fourth round inside 15 minutes
  });
});
