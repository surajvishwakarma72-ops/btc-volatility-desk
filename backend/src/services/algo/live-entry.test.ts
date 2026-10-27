import { describe, expect, it } from 'vitest';
import { makeLiveBroker, type LiveEntryDeps } from './live-entry.js';
import { defaultStrangle } from '../../lib/algo/rule.js';
import type { EntryPlan } from './algo-engine.js';
import type { OptionPosition } from '../watch/live-exit.js';

const leg = (symbol: string, type: 'call' | 'put', side: 'sell' | 'buy' = 'sell') => ({ symbol, side, lots: 10, bid: 60, ask: 65, delta: 0.12, strike: 100_000, expiryCode: '271026', type });
const plan: EntryPlan = { kind: 'option', legs: [leg('C-BTC-105000-271026', 'call'), leg('P-BTC-95000-271026', 'put')], expiries: ['271026'], spot: 100_000, premium: 1.2 };

function rig(o: { armed?: boolean; dry?: boolean; enabled?: boolean; key?: boolean; fill?: 'all' | 'none' | 'half'; stopFail?: boolean } = {}) {
  const posts: any[] = [];
  const stopPosts: any[] = [];
  const cancels: any[] = [];
  const events: string[] = [];
  let positions: OptionPosition[] = [];
  const d: LiveEntryDeps = {
    liveEnabled: () => o.enabled ?? true,
    cfg: async () => ({ liveArmed: o.armed ?? true, dryRun: o.dry ?? false }),
    tradeKey: async () => (o.key === false ? null : { key: 'k', secret: 's' }),
    positions: async () => positions,
    book: async () => ({ bids: [[60, 100]], asks: [[65, 100]] }) as any,
    productId: async (s) => (s.startsWith('C') ? 11 : 22),
    tickOf: () => 0.5,
    cancel: async (_k, _s, payload) => { cancels.push(payload); return { ok: true, status: 200, body: {}, errorText: '' }; },
    post: async (_k, _s, payload) => {
      if (payload.stop_order_type) {
        if (o.stopFail) return { ok: false, status: 400, body: null, errorText: 'stop_orders_not_allowed' };
        stopPosts.push(payload);
        return { ok: true, status: 200, body: { result: { id: 900 + stopPosts.length } }, errorText: '' };
      }
      posts.push(payload);
      const sym = payload.product_id === 11 ? 'C-BTC-105000-271026' : 'P-BTC-95000-271026';
      const sign = payload.side === 'buy' ? 1 : -1;
      const filled = payload.reduce_only ? (o.fill === 'none' ? 0 : Number(payload.size)) : o.fill === 'none' ? 0 : o.fill === 'half' && sym.startsWith('P') ? Number(payload.size) / 2 : Number(payload.size);
      const cur = positions.find((p) => p.symbol === sym);
      if (cur) cur.size += sign * filled; else positions.push({ productId: Number(payload.product_id), symbol: sym, size: sign * filled, entry: 60 });
      positions = positions.filter((p) => p.size !== 0);
      return { ok: true, status: 200, body: {}, errorText: '' };
    },
    log: async (_u, kind) => { events.push(kind); },
    sleep: async () => undefined,
  };
  return { broker: makeLiveBroker(d), posts, stopPosts, cancels, events, get positions() { return positions; } };
}

describe('live entry locks', () => {
  it('refuses when live trading is not armed', async () => {
    const r = rig({ armed: false });
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out.ok).toBe(false);
    expect(r.posts).toHaveLength(0);
  });
  it('refuses real orders without the server switch', async () => {
    const r = rig({ enabled: false, dry: false });
    expect((await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x')).ok).toBe(false);
    expect(r.posts).toHaveLength(0);
  });
  it('refuses without a trading key', async () => {
    const r = rig({ key: false });
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out.ok).toBe(false);
    expect(r.posts).toHaveLength(0);
  });
  it('dry-run writes events and sends nothing', async () => {
    const r = rig({ dry: true, enabled: false });
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out).toMatchObject({ ok: true, dry: true });
    expect(r.posts).toHaveLength(0);
    expect(r.events.filter((e) => e === 'algo_entry_dry')).toHaveLength(2);
  });
  it('live futures are not available yet', async () => {
    const r = rig();
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), { kind: 'future', future: { side: 'long', lots: 5, spot: 100_000 } }, 'x');
    expect(out.ok).toBe(false);
    expect(r.posts).toHaveLength(0);
  });
});

describe('live entry orders', () => {
  it('sends marketable immediate-or-cancel limit orders through the book, not reduce-only', async () => {
    const r = rig();
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out.ok).toBe(true);
    expect(r.posts).toHaveLength(2);
    for (const p of r.posts) {
      expect(p).toMatchObject({ order_type: 'limit_order', time_in_force: 'ioc', reduce_only: false, size: 10 });
      expect(p.side).toBe('sell');
      expect(Number(p.limit_price)).toBeLessThan(60); // sells go below the best bid so they fill
    }
  });
  it('hedges (bought legs) go first', async () => {
    const r = rig();
    const p2: EntryPlan = { kind: 'option', legs: [leg('C-BTC-105000-271026', 'call'), leg('P-BTC-95000-271026', 'put', 'buy')], expiries: ['271026'], spot: 1, premium: 0 };
    await r.broker.place('u', defaultStrangle({ mode: 'live' }), p2, 'x');
    expect(r.posts[0].side).toBe('buy');
  });
  it('undoes the filled legs by exactly the filled amount when a leg only half fills', async () => {
    const r = rig({ fill: 'half' });
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out.ok).toBe(false);
    const undo = r.posts.filter((p) => p.reduce_only === true);
    expect(undo.map((p) => ({ id: p.product_id, size: p.size, side: p.side }))).toEqual(expect.arrayContaining([{ id: 11, size: 10, side: 'buy' }, { id: 22, size: 5, side: 'buy' }]));
    expect(r.positions).toHaveLength(0);
  });
  it('nothing filled means nothing to undo', async () => {
    const r = rig({ fill: 'none' });
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out.ok).toBe(false);
    expect(r.posts.filter((p) => p.reduce_only === true)).toHaveLength(0);
  });
});

describe('exchange stop-loss orders', () => {
  it('puts a reduce-only stop-loss on Delta for every sold leg, at the stop multiple of its sell price, and says so', async () => {
    const r = rig();
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out.ok).toBe(true);
    expect(r.stopPosts).toHaveLength(2);
    for (const p of r.stopPosts) {
      expect(p).toMatchObject({ side: 'buy', stop_order_type: 'stop_loss_order', stop_trigger_method: 'mark_price', reduce_only: true, time_in_force: 'gtc', order_type: 'limit_order', size: 10, stop_price: '120' });
      expect(Number(p.limit_price)).toBeGreaterThan(120);
    }
    expect(out.ok && out.detail).toMatch(/Stop-loss on Delta: 2 of 2 sold legs/);
    expect(JSON.parse((out as any).ref).stops).toHaveLength(2);
  });
  it('reports honestly when Delta refuses the stops: the entry stays, the detail says none were placed', async () => {
    const r = rig({ stopFail: true });
    const out = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    expect(out.ok).toBe(true);
    expect(out.ok && out.detail).toMatch(/Stop-loss on Delta: 0 of 2 sold legs. NOT placed/);
    expect(r.events).toContain('algo_stop_failed');
  });
  it('sends no stop when the rule has no per-leg stop, and says so', async () => {
    const r = rig();
    const rule = defaultStrangle({ mode: 'live' }); rule.exit.legStopMultiple = null;
    const out = await r.broker.place('u', rule, plan, 'x');
    expect(r.stopPosts).toHaveLength(0);
    expect(out.ok && out.detail).toMatch(/No per-leg stop/);
  });
  it('closeAll cancels the stop orders it placed, and status flags a leg that is gone', async () => {
    const r = rig();
    const placed = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    if (!placed.ok) throw new Error('setup');
    r.positions.splice(0, 1); // one leg's stop fired
    const st = await r.broker.status('u', placed.ref);
    expect(st?.open).toBe(true);
    expect(st?.legGone).toBe(true);
    await r.broker.closeAll('u', placed.ref, 'leg stopped');
    expect(r.cancels.map((c) => c.id).sort()).toEqual([901, 902]);
  });
});

describe('live status and close', () => {
  it('tracks the run symbols and closes only them, reduce-only', async () => {
    const r = rig();
    const placed = await r.broker.place('u', defaultStrangle({ mode: 'live' }), plan, 'x');
    if (!placed.ok) throw new Error('setup');
    // someone else's position in another contract must be left alone
    r.positions.push({ productId: 99, symbol: 'C-BTC-110000-271026', size: -3, entry: 20 });
    const st = await r.broker.status('u', placed.ref);
    expect(st?.open).toBe(true);
    expect(st?.netPnl).not.toBeNull();
    r.posts.length = 0;
    const res = await r.broker.closeAll('u', placed.ref, 'net target');
    expect(res.ok).toBe(true);
    expect(r.posts.every((p) => p.reduce_only === true)).toBe(true);
    expect(r.posts.map((p) => p.product_id).sort()).toEqual([11, 22]);
  });
  it('closeAll sends nothing in dry-run', async () => {
    const r = rig({ dry: true });
    const res = await r.broker.closeAll('u', JSON.stringify({ symbols: ['C-BTC-105000-271026'] }), 'x');
    expect(res.ok).toBe(false);
    expect(r.posts).toHaveLength(0);
  });
  it('reports closed when the contracts are flat', async () => {
    const r = rig();
    const st = await r.broker.status('u', JSON.stringify({ symbols: ['C-BTC-105000-271026'] }));
    expect(st?.open).toBe(false);
  });
});
