import { describe, expect, it } from 'vitest';
import { AutoStop, STOP_PREFIX, type AutoStopDeps, type PendingStop } from './auto-stop.js';
import type { OptionPosition } from './live-exit.js';

const C: OptionPosition = { productId: 11, symbol: 'C-BTC-105000-271026', size: -10, entry: 100 };
const P: OptionPosition = { productId: 22, symbol: 'P-BTC-95000-271026', size: -10, entry: 80 };
const HEDGE: OptionPosition = { productId: 33, symbol: 'P-BTC-90000-271026', size: 10, entry: 5 };

function rig(o: { armed?: boolean; dry?: boolean; enabled?: boolean; key?: boolean; pending?: PendingStop[]; readFails?: boolean; postFails?: boolean } = {}) {
  let t = 1_000_000;
  const posts: any[] = [], cancels: any[] = [], closes: Array<{ expiry: string; reason: string }> = [], events: Array<{ kind: string; dry: boolean }> = [];
  const d: AutoStopDeps = {
    now: () => t,
    liveEnabled: () => o.enabled ?? true,
    cfg: async () => ({ liveArmed: o.armed ?? true, dryRun: o.dry ?? false, stopMultiple: 2 }),
    tradeKey: async () => (o.key === false ? null : { key: 'k', secret: 's' }),
    pendingStops: async () => { if (o.readFails) throw new Error('orders down'); return o.pending ?? []; },
    tickOf: () => 0.5,
    post: async (_k, _s, p) => { posts.push(p); return o.postFails ? { ok: false, status: 400, body: null, errorText: 'stop_orders_not_allowed' } : { ok: true, status: 200, body: { result: { id: posts.length } }, errorText: '' }; },
    cancel: async (_k, _s, p) => { cancels.push(p); return { ok: true, status: 200, body: {}, errorText: '' }; },
    log: async (_u, kind, _d, x) => { events.push({ kind, dry: x.dryRun }); },
    closeGroup: async (_u, expiry, _l, reason) => { closes.push({ expiry, reason }); },
  };
  const as = new AutoStop(d);
  /** a first look, then one after the 20 s settle time and the 30 s throttle */
  const twice = async (list: OptionPosition[]) => { await as.run('u', list); t += 31_000; await as.run('u', list); };
  return { as, twice, posts, cancels, closes, events, advance: (ms: number) => { t += ms; } };
}

describe('automatic 2x stop-loss on the trading account', () => {
  it('places a reduce-only stop-limit on every sold leg without one, at 2x its sell price, and leaves bought legs alone', async () => {
    const r = rig();
    await r.twice([C, P, HEDGE]);
    expect(r.posts).toHaveLength(2);
    expect(r.posts.map((p) => p.product_id).sort()).toEqual([11, 22]);
    expect(r.posts.find((p) => p.product_id === 11)).toMatchObject({ side: 'buy', size: 10, stop_order_type: 'stop_loss_order', stop_trigger_method: 'mark_price', stop_price: '200', reduce_only: true, time_in_force: 'gtc', order_type: 'limit_order' });
    expect(r.posts.find((p) => p.product_id === 22)).toMatchObject({ stop_price: '160' });
    expect(r.posts.find((p) => p.product_id === 11)!.limit_price).toBe('220'); // 10% above the 200 trigger
    expect(r.posts.find((p) => p.product_id === 22)!.limit_price).toBe('176'); // 10% above the 160 trigger
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

  it('still places the stops when Delta will not list the pending orders, once per leg, and says so', async () => {
    const r = rig({ readFails: true });
    await r.twice([C, P]);
    r.advance(31_000); await r.as.run('u', [C, P]);
    expect(r.posts.map((p) => p.product_id).sort()).toEqual([11, 22]); // not placed again on the later rounds
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

describe('the two emergencies: a stop that jumped, and a naked leg', () => {
  const marksOf = (m: Record<string, number>) => (s: string) => m[s] ?? null;

  it('closes the whole expiry at market when a sold leg is already past the stop-limit price (the stop cannot fill)', async () => {
    const r = rig();
    await r.as.guard('u', [C, P], marksOf({ [C.symbol]: 190, [P.symbol]: 70 })); // 190 is under the 200 trigger
    expect(r.closes).toHaveLength(0);
    await r.as.guard('u', [C, P], marksOf({ [C.symbol]: 225, [P.symbol]: 70 })); // past the 220 limit: it jumped
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({ expiry: '271026' });
    expect(r.closes[0]!.reason).toMatch(/stop jumped.*C-BTC-105000-271026/);
  });

  it('does not treat a price between the trigger and the limit as a jump, because the stop order can still fill there', async () => {
    const r = rig();
    await r.as.guard('u', [C, P], marksOf({ [C.symbol]: 210, [P.symbol]: 70 }));
    expect(r.closes).toHaveLength(0);
  });

  it('closes the remaining leg at market when one sold leg disappears, and only once', async () => {
    const r = rig();
    await r.as.guard('u', [C, P], marksOf({ [C.symbol]: 100, [P.symbol]: 80 }));
    expect(r.closes).toHaveLength(0);
    await r.as.guard('u', [P], marksOf({ [P.symbol]: 80 })); // the call leg is gone
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]!.reason).toMatch(/naked leg: C-BTC-105000-271026 is no longer open while P-BTC-95000-271026 remains/);
    await r.as.guard('u', [P], marksOf({ [P.symbol]: 80 }));
    expect(r.closes).toHaveLength(1); // not again for the same missing leg
  });

  it('does nothing when both legs close together, or when the desk has only just started and sees one leg', async () => {
    const r = rig();
    await r.as.guard('u', [P], marksOf({ [P.symbol]: 80 })); // first look: nothing to compare with
    await r.as.guard('u', [C, P], marksOf({}));
    await r.as.guard('u', [], marksOf({})); // both gone
    expect(r.closes).toHaveLength(0);
  });

  it('only acts while the hard exit is armed', async () => {
    const r = rig({ armed: false });
    await r.as.guard('u', [C, P], marksOf({ [C.symbol]: 300 }));
    expect(r.closes).toHaveLength(0);
  });

  it('a different expiry is judged on its own', async () => {
    const r = rig();
    const C2: OptionPosition = { productId: 44, symbol: 'C-BTC-110000-281026', size: -10, entry: 50 };
    await r.as.guard('u', [C, P, C2], marksOf({}));
    await r.as.guard('u', [P, C2], marksOf({})); // the 271026 call is gone; 281026 is untouched
    expect(r.closes.map((c) => c.expiry)).toEqual(['271026']);
  });
});
