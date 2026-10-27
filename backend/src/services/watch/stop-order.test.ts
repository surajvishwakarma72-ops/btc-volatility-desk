import { describe, expect, it } from 'vitest';
import { placeStop, type PostFn } from './stop-order.js';

const spec = { productId: 11, size: 10, stopPrice: 200, limitPrice: 250 };
const ok = (id: number) => ({ ok: true, status: 200, body: { result: { id } }, errorText: '' });
const no = (why: string) => ({ ok: false, status: 400, body: null, errorText: why });

describe('placeStop', () => {
  it('uses the stop-limit on the mark price when Delta takes it', async () => {
    const sent: any[] = [];
    const post: PostFn = async (_k, _s, p) => { sent.push(p); return ok(5); };
    const r = await placeStop(post, 'k', 's', spec);
    expect(r).toMatchObject({ ok: true, id: 5, how: 'stop-limit on the mark price' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ side: 'buy', reduce_only: true, stop_order_type: 'stop_loss_order', stop_price: '200', limit_price: '250', order_type: 'limit_order', stop_trigger_method: 'mark_price' });
  });
  it('falls back to the last-price trigger, then to a stop-market, and says which one worked', async () => {
    const sent: any[] = [];
    const post: PostFn = async (_k, _s, p) => { sent.push(p); return sent.length < 3 ? no('invalid_order_type') : ok(9); };
    const r = await placeStop(post, 'k', 's', spec);
    expect(r).toMatchObject({ ok: true, id: 9, how: 'stop-market on the mark price' });
    expect(sent[1]).toMatchObject({ stop_trigger_method: 'last_traded_price', order_type: 'limit_order' });
    expect(sent[2]).toMatchObject({ order_type: 'market_order', reduce_only: true });
    expect(r.errors).toHaveLength(2);
  });
  it('returns every refusal when Delta takes none', async () => {
    const r = await placeStop(async () => no('stop_orders_not_allowed'), 'k', 's', spec);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toContain('stop_orders_not_allowed');
  });
});
