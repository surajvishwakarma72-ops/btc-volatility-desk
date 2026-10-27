/**
 * One stop-loss on a sold option leg, sent to Delta. Delta's documents do not say which stop orders an options contract accepts, so this
 * tries them in turn and reports the one that was accepted (or every refusal, so the reason is on screen):
 *   1. stop-limit, triggered on the mark price (a buy limit well through the trigger so it fills)
 *   2. stop-limit, triggered on the last traded price
 *   3. stop-market, triggered on the mark price
 * Every one is a reduce-only buy that can only close the short leg; none can open or enlarge a position.
 */
type Reply = { ok: boolean; status: number; body: any; errorText: string };
export type PostFn = (key: string, secret: string, payload: Record<string, unknown>) => Promise<Reply>;

export interface StopSpec { productId: number; size: number; stopPrice: number; limitPrice: number; clientOrderId?: string }
export interface StopResult { ok: boolean; id?: number; how?: string; errors: string[] }

const fmt = (v: number): string => String(Number(v.toFixed(6)));

/** How far above the trigger a stop-limit's limit price sits: room to fill if the price jumps past the trigger, without paying far more than the stop. */
export const STOP_LIMIT_BUFFER = 0.10;

/** The limit price for a stop-limit buy: 10% above the trigger, and never less than 3 ticks above it, rounded up to the tick. */
export function stopLimitPrice(stopPrice: number, tick: number): number {
  return Math.ceil(Math.max(stopPrice * (1 + STOP_LIMIT_BUFFER), stopPrice + 3 * tick) / tick - 1e-9) * tick;
}

export async function placeStop(post: PostFn, key: string, secret: string, s: StopSpec): Promise<StopResult> {
  const base = { product_id: s.productId, size: s.size, side: 'buy', stop_order_type: 'stop_loss_order', stop_price: fmt(s.stopPrice), time_in_force: 'gtc', reduce_only: true, ...(s.clientOrderId ? { client_order_id: s.clientOrderId } : {}) };
  const tries: Array<[string, Record<string, unknown>]> = [
    ['stop-limit on the mark price', { ...base, order_type: 'limit_order', limit_price: fmt(s.limitPrice), stop_trigger_method: 'mark_price' }],
    ['stop-limit on the last price', { ...base, order_type: 'limit_order', limit_price: fmt(s.limitPrice), stop_trigger_method: 'last_traded_price' }],
    ['stop-market on the mark price', { ...base, order_type: 'market_order', stop_trigger_method: 'mark_price' }],
  ];
  const errors: string[] = [];
  for (const [how, payload] of tries) {
    const r = await post(key, secret, payload);
    const id = Number(r.body?.result?.id);
    if (r.ok && Number.isFinite(id)) return { ok: true, id, how, errors };
    errors.push(`${how}: ${r.errorText || r.status}`);
  }
  return { ok: false, errors };
}
