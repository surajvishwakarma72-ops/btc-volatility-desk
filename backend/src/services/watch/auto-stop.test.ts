import { describe, expect, it } from 'vitest';
import { AutoStop, STOP_PREFIX, type AutoStopDeps, type PendingStop } from './auto-stop.js';
import type { OptionPosition } from './live-exit.js';

const C: OptionPosition = { productId: 11, symbol: 'C-BTC-105000-271026', size: -10, entry: 100 };
const P: OptionPosition = { productId: 22, symbol: 'P-BTC-95000-271026', size: -10, entry: 80 };
const HEDGE: OptionPosition = { productId: 33, symbol: 'P-BTC-90000-271026', size: 10, entry: 5 };

function rig(o: { armed?: boolean; dry?: boolean; enabled?: boolean; key?: boolean; pending?: PendingStop[]; readFails?: boolean; postFails?: boolean } = {}) {
  let t = 1_000_000;
  const posts: any[] = [], cancels: any[] = [], events: Array<{ kind: string; dry: boolean }> = [];
  const d: AutoStopDeps = {
    now: () => t,
    liveEnabled: () => o.enabled ?? true,
    cfg: async () => ({ liveArmed: o.armed ?? true, dryRun: o.dry ?? false, stopMultiple: 2 }),
    tradeKey: async () => (o.key === false ? null : { key: 'k', secret: 's' }),
    pendingStops: async () => { if (o.readFails) throw new Error('orders down'); return o.pending ?? []; },
    tickOf: () => 0.5,
    post: async (_k, _s, p) => { posts.push(p); return o.postFails ? { ok: false, status: 400, body: null, errorText: 'stop_orders_not_allowed' } : { ok: true, status: 200, body: {}, errorText: '' }; },
    cancel: async (_k, _s, p) => { cancels.push(p); return { ok: true, status: 200, body: {}, errorText: '' }; },
    log: async (_u, kind, _d, x) => { events.push({ kind, dry: x.dryRun }); },
  };
  const as = new AutoStop(d);
  /** a first look, then one after the 20 s settle time and the 30 s throttle */
  const twice = async (list: OptionPosition[]) => { await as.run('u', list); t += 31_000; await as.run('u', list); };
  return { as, twice, posts, cancels, events, advance: (ms: number) => { t += ms; } };
}

describe('automatic 2x stop-loss on the trading account', () => {
  it('places a reduce-only stop-limit on every sold leg without one, at 2x its sell price, and leaves bought legs alone', async () => {
    const r = rig();
    await r.twice([C, P, HEDGE]);
    expect(r.posts).toHaveLength(2);
    expect(r.posts.map((p) => p.product_id).sort()).toEqual([11, 22]);
    expect(r.posts.find((p) => p.product_id === 11)).toMatchObject({ side: 'buy', size: 10, stop_order_type: 'stop_loss_order', stop_trigger_method: 'mark_price', stop_price: '200', reduce_only: true, time_in_force: 'gtc', order_type: 'limit_order' });
    expect(r.posts.find((p) => p.product_id === 22)).toMatchObject({ stop_price: '160' });
    expect(String(r.posts[0].client_order_id).startsWith(STOP_PREFIX)).toBe(true);
    expect(r.events.filter((e) => e.kind === 'auto_stop_order')).toHaveLength(2);
  });

  it('does not wait-and-double: a leg that already has a pending stop is left alone', async () => {
    const r = rig({ pending: [{ id: 1, productId: 11, symbol: C.symbol, side: 'buy', reduceOnly: true, clientOrderId: null }] });
    await r.twice([C, P]);
    expect(r.posts.map((p) => p.product_id)).toEqual([22]);
  });

  it('waits 20 s before touching a position that has only just appeared', async () => {
    const r = rig();
    await r.as.run('u', [C]);
    expect(r.posts).toHaveLength(0);
  });

  it('sends nothing in dry-run, without the server switch, unarmed, or with no trading key', async () => {
    for (const o of [{ dry: true }, { enabled: false }, { armed: false }, { key: false }]) {
      const r = rig(o);
      await r.twice([C, P]);
      expect(r.posts, JSON.stringify(o)).toHaveLength(0);
    }
    const dry = rig({ dry: true });
    await dry.twice([C]);
    expect(dry.events.some((e) => e.kind === 'auto_stop_dry' && e.dry)).toBe(true);
  });

  it('says plainly when Delta refuses the stop, and does not flood the list', async () => {
    const r = rig({ postFails: true });
    await r.twice([C]);
    r.advance(31_000); await r.as.run('u', [C]);
    expect(r.events.filter((e) => e.kind === 'auto_stop_failed')).toHaveLength(1);
  });

  it('places nothing when it cannot read the pending orders (it could double up otherwise)', async () => {
    const r = rig({ readFails: true });
    await r.twice([C, P]);
    expect(r.posts).toHaveLength(0);
    expect(r.events.some((e) => e.kind === 'auto_stop_failed')).toBe(true);
  });

  it('cancels a stop it placed on a leg that is no longer open, and never one it did not place', async () => {
    const r = rig({ pending: [
      { id: 7, productId: 11, symbol: C.symbol, side: 'buy', reduceOnly: true, clientOrderId: `${STOP_PREFIX}11-1` },
      { id: 8, productId: 99, symbol: 'C-BTC-1-271026', side: 'buy', reduceOnly: true, clientOrderId: 'my-own-stop' },
    ] });
    await r.twice([P]);
    expect(r.cancels.length).toBeGreaterThan(0);
    expect(r.cancels.every((c) => c.id === 7 && c.product_id === 11)).toBe(true); // the fake order list does not shrink, so a second round repeats it
  });
});
