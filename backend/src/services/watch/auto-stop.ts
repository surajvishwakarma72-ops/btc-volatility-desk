import { deltaSignedDelete, deltaSignedGet, deltaSignedPost } from '../../routes/delta.js';
import { loadOrderKey } from '../delta-keys.js';
import { getWatchConfig, logWatchEvent } from './watch-store.js';
import { expiryOf, type OptionPosition } from './live-exit.js';
import { placeStop, stopLimitPrice } from './stop-order.js';

/**
 * Automatic stop-loss on the trading account: every SOLD option leg gets a real stop order on Delta (a reduce-only buy, stop-limit,
 * triggered on the mark price at the stop multiple of the sell price, 2x by default), however the position was opened (algo, Ask me
 * or by hand). A leg that already has a pending stop is left alone, and stops this desk placed on a leg that is no longer open are
 * cancelled. It sends orders only under the same locks as every other real order: trading key saved, armed, dry-run off, and
 * LIVE_TRADING_ENABLED on the server. Otherwise it only writes what it WOULD place.
 */
export interface PendingStop { id: number; productId: number; symbol: string; side: string; reduceOnly: boolean; clientOrderId: string | null }
type Reply = { ok: boolean; status: number; body: any; errorText: string };

export interface AutoStopDeps {
  now(): number;
  liveEnabled(): boolean;
  cfg(userId: string): Promise<{ liveArmed: boolean; dryRun: boolean; stopMultiple: number }>;
  tradeKey(userId: string): Promise<{ key: string; secret: string } | null>;
  pendingStops(key: string, secret: string): Promise<PendingStop[]>;
  tickOf(symbol: string): number;
  post(key: string, secret: string, payload: Record<string, unknown>): Promise<Reply>;
  cancel(key: string, secret: string, payload: Record<string, unknown>): Promise<Reply>;
  log(userId: string, kind: string, detail: string, o: { symbol?: string; dryRun: boolean }): Promise<void>;
  /** Close every option position in one expiry at market (the hard exit's closer, with its locks, retries and event log). */
  closeGroup(userId: string, expiry: string, label: string, reason: string, cfg: { liveArmed: boolean; dryRun: boolean }): Promise<void>;
}

export const STOP_PREFIX = 'desk-stop-';
const EVERY_MS = 30_000, SETTLE_MS = 20_000, NOTE_MS = 10 * 60_000, REPLACE_MS = 5 * 60_000;
const roundUp = (price: number, tick: number): number => Math.ceil(price / tick - 1e-9) * tick;
const fmt = (v: number): string => String(Number(v.toFixed(6)));

export class AutoStop {
  private lastRun = new Map<string, number>();
  private firstSeen = new Map<string, number>();
  private noted = new Map<string, number>();
  private placedAt = new Map<string, number>();
  /** user|expiry -> the sold contracts seen open there, to notice when one of them is gone */
  private soldSeen = new Map<string, Set<string>>();

  /**
   * The two emergencies, checked on every position read (about every 5 s) for the trading account, only while armed:
   *  1. a stop that JUMPED: a sold leg's mark is already past the stop-limit's limit price while the leg is still open, so the stop order
   *     cannot fill. Everything in that expiry is closed at market.
   *  2. a naked leg: a sold leg that was open is gone (its stop fired, or it was closed) while another sold leg in the same expiry remains.
   *     The remaining leg is closed at market.
   * The closer itself refuses unless dry-run is off and the server switch is on, and then only writes what it would do.
   */
  async guard(userId: string, positions: readonly OptionPosition[], markOf: (symbol: string) => number | null): Promise<void> {
    const d = this.d;
    const cfg = await d.cfg(userId);
    if (!cfg.liveArmed) return;
    const byExpiry = new Map<string, OptionPosition[]>();
    for (const p of positions) (byExpiry.get(expiryOf(p.symbol)) ?? byExpiry.set(expiryOf(p.symbol), []).get(expiryOf(p.symbol))!).push(p);
    // a whole expiry that was open and is now gone (closed by the desk, by a stop, or by you): take its stops off Delta at once
    let closedSomething = false;
    for (const k of [...this.soldSeen.keys()]) if (k.startsWith(userId + '|') && !byExpiry.has(k.slice(userId.length + 1))) { this.soldSeen.delete(k); closedSomething = true; }
    for (const [expiry, list] of byExpiry) {
      const sold = list.filter((p) => p.size < 0), sk = `${userId}|${expiry}`, now = new Set(sold.map((p) => p.symbol)), before = this.soldSeen.get(sk);
      if (now.size) this.soldSeen.set(sk, new Set(now)); else this.soldSeen.delete(sk); // from here on, a leg missing from the next read is compared with this one
      const label = `Delta · expiry ${expiry}`;
      const jumped = sold.find((p) => { const m = markOf(p.symbol); return m != null && p.entry > 0 && m > stopLimitPrice(roundUp(p.entry * cfg.stopMultiple, d.tickOf(p.symbol) || 0.1), d.tickOf(p.symbol) || 0.1); });
      if (jumped) {
        await d.closeGroup(userId, expiry, label, `stop jumped: ${jumped.symbol} is at ${markOf(jumped.symbol)}, past the stop-limit's limit price, so the stop cannot fill; closing every leg of this expiry at market`, cfg);
        continue;
      }
      const gone = before ? [...before].filter((s) => !now.has(s)) : [];
      if (gone.length) closedSomething = true;
      if (gone.length && now.size) {
        await d.closeGroup(userId, expiry, label, `naked leg: ${gone.join(', ')} is no longer open while ${[...now].join(', ')} remains; closing the remaining leg at market`, cfg);
      }
    }
    if (closedSomething) await this.cleanupNow(userId, positions);
  }
  constructor(private readonly d: AutoStopDeps) {}

  /** `positions` are all the option positions of the TRADING account, as just read from Delta. */
  async run(userId: string, positions: readonly OptionPosition[]): Promise<void> {
    const d = this.d, now = d.now();
    if (now - (this.lastRun.get(userId) ?? 0) < EVERY_MS) return;
    const cfg = await d.cfg(userId);
    if (!cfg.liveArmed) return;
    const creds = await d.tradeKey(userId);
    if (!creds) return;
    this.lastRun.set(userId, now);
    const live = !cfg.dryRun && d.liveEnabled();
    const sold = positions.filter((p) => p.size < 0);
    for (const k of [...this.firstSeen.keys()]) if (k.startsWith(userId + '|') && !sold.some((p) => k === `${userId}|${p.symbol}`)) this.firstSeen.delete(k);
    // If Delta will not list the pending orders, the stop is still placed: a leg with no stop is the worse mistake, and the desk remembers
    // what it sent (placedAt below) so it does not repeat itself. A duplicate reduce-only stop cannot enlarge a position.
    let pending: PendingStop[] = [];
    try { pending = await d.pendingStops(creds.key, creds.secret); }
    catch (e) { await this.note(userId, 'read', 'auto_stop_failed', `Could not read the pending orders on Delta (${(e as Error).message}). Placing the stops anyway, so a leg is not left without one.`, undefined, live); }

    const covered = new Set(pending.filter((s) => s.side === 'buy' && s.reduceOnly).map((s) => s.productId));
    for (const p of sold) {
      const fk = `${userId}|${p.symbol}`, seen = this.firstSeen.get(fk) ?? now;
      this.firstSeen.set(fk, seen);
      if (covered.has(p.productId) || now - seen < SETTLE_MS) continue; // already has a stop, or only just appeared (an entry may still be placing its own)
      if (now - (this.placedAt.get(fk) ?? 0) < REPLACE_MS) continue; // this desk sent one for this leg a moment ago
      if (!(p.entry > 0)) continue;
      const tick = d.tickOf(p.symbol) || 0.1, size = Math.abs(p.size);
      const stopPrice = roundUp(p.entry * cfg.stopMultiple, tick), limit = stopLimitPrice(stopPrice, tick);
      const what = `buy ${size} ${p.symbol} when the mark reaches ${fmt(stopPrice)} (${cfg.stopMultiple}x the sell price ${p.entry}), limit ${fmt(limit)}`;
      if (!live) { await this.note(userId, p.symbol, 'auto_stop_dry', `DRY RUN, nothing sent: would place a stop-loss on Delta: ${what}.`, p.symbol, false); continue; }
      const r = await placeStop(d.post, creds.key, creds.secret, { productId: p.productId, size, stopPrice, limitPrice: limit, clientOrderId: `${STOP_PREFIX}${p.productId}-${Math.floor(now / 1000)}` });
      if (r.ok) this.placedAt.set(fk, now);
      if (r.ok) await d.log(userId, 'auto_stop_order', `Stop-loss placed on Delta (${r.how}): ${what}.`, { symbol: p.symbol, dryRun: false });
      else await this.note(userId, p.symbol, 'auto_stop_failed', `Stop-loss NOT placed on Delta for ${p.symbol}. Delta said: ${r.errors.join(' | ')}.`, p.symbol, false);
    }

    // stops left behind on legs that are no longer open
    if (live) await this.cancelOrphans(userId, creds, pending, positions);
  }

  /**
   * Cancel every pending reduce-only stop that has nothing left to protect: a buy stop needs an open short in that contract, a sell stop an
   * open long. They are cancelled the moment the position is gone, so none can sit on Delta and fire later. A stop that is not reduce-only
   * (an order you placed to open a position) is never touched.
   */
  private async cancelOrphans(userId: string, creds: { key: string; secret: string }, pending: readonly PendingStop[], positions: readonly OptionPosition[]): Promise<void> {
    const d = this.d;
    for (const s of pending) {
      if (!s.reduceOnly) continue;
      if (positions.some((p) => p.productId === s.productId && (s.side === 'buy' ? p.size < 0 : p.size > 0))) continue;
      const c = await d.cancel(creds.key, creds.secret, { id: s.id, product_id: s.productId }).catch(() => null);
      await d.log(userId, c?.ok ? 'auto_stop_cancelled' : 'auto_stop_failed', c?.ok ? `Cancelled the stop order on ${s.symbol}: the leg is no longer open.` : `Could not cancel the leftover stop order ${s.id} on ${s.symbol}${c ? `: ${c.errorText || c.status}` : ''}.`, { symbol: s.symbol, dryRun: false });
    }
  }

  /** Read Delta's pending stops and cancel the orphans now (called the moment a leg or a whole position is seen to be gone). */
  private async cleanupNow(userId: string, positions: readonly OptionPosition[]): Promise<void> {
    const d = this.d;
    const cfg = await d.cfg(userId);
    if (cfg.dryRun || !d.liveEnabled()) return;
    const creds = await d.tradeKey(userId);
    if (!creds) return;
    let pending: PendingStop[];
    try { pending = await d.pendingStops(creds.key, creds.secret); } catch { return; } // the 30 s round tries again
    await this.cancelOrphans(userId, creds, pending, positions);
  }

  /** A line in the event list, at most once per ten minutes for the same thing, so a standing problem does not flood it. */
  private async note(userId: string, key: string, kind: string, detail: string, symbol: string | undefined, live: boolean): Promise<void> {
    const nk = `${userId}|${kind}|${key}`, now = this.d.now();
    if (now - (this.noted.get(nk) ?? 0) < NOTE_MS) return;
    this.noted.set(nk, now);
    await this.d.log(userId, kind, detail, { symbol, dryRun: !live });
  }
}

export const realAutoStopDeps = (tickOf: (s: string) => number, closeGroup?: AutoStopDeps['closeGroup']): AutoStopDeps => ({
  now: () => Date.now(),
  liveEnabled: () => process.env.LIVE_TRADING_ENABLED === 'true',
  cfg: (uid) => getWatchConfig(uid, 0),
  tradeKey: (uid) => loadOrderKey(uid),
  async pendingStops(key, secret) {
    const r = await deltaSignedGet(key, secret, '/v2/orders', 'states=pending&contract_types=call_options,put_options&order_types=all_stop');
    if (!r.ok) throw new Error(r.errorText || String(r.status));
    return (((r.body as any)?.result ?? []) as any[]).map((o) => ({ id: Number(o.id), productId: Number(o.product_id), symbol: String(o.product_symbol ?? ''), side: String(o.side), reduceOnly: !!o.reduce_only, clientOrderId: o.client_order_id ? String(o.client_order_id) : null }));
  },
  tickOf,
  post: (key, secret, payload) => deltaSignedPost(key, secret, '/v2/orders', payload),
  cancel: (key, secret, payload) => deltaSignedDelete(key, secret, '/v2/orders', payload),
  log: (uid, kind, detail, o) => logWatchEvent(uid, kind, detail, o),
  closeGroup: closeGroup ?? (async () => undefined),
});
