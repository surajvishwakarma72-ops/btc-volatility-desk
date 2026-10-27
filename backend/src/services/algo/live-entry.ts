import { deltaGet } from '../bot/delta-public.js';
import { fetchBook, type Book } from '../bot/delta-public.js';
import { deltaSignedDelete, deltaSignedPost } from '../../routes/delta.js';
import { placeStop } from '../watch/stop-order.js';
import { loadDeltaKey } from '../delta-keys.js';
import { logWatchEvent, getWatchConfig } from '../watch/watch-store.js';
import { buildClosingOrders, expiryOf, fetchOptionPositions, LiveExit, OPTION_EXPIRY, realLiveExitDeps, type OptionPosition } from '../watch/live-exit.js';
import { marketFeed } from '../paper/paper-terminal.js';
import type { AlgoStrategy } from '../../lib/algo/rule.js';
import type { Broker, BrokerStatus, EntryPlan, PlaceResult } from './algo-engine.js';

/**
 * LIVE entry on real Delta, behind the same locks as the hard exit and one more rule: nothing here runs unless the user
 * (1) saved a trading key, (2) armed live trading, (3) turned dry-run off, and the server owner set LIVE_TRADING_ENABLED=true.
 * With dry-run on (the default) it only writes what it WOULD send, and the Algo run is recorded as "dry".
 *
 * "Market order" on Delta India options is a marketable immediate-or-cancel LIMIT order priced a few ticks through the best
 * opposite price: it fills like a market order but can never run away on a thin book. If any leg does not fill completely, the
 * legs that did are closed again, by exactly the amount that was filled (never the user's other positions).
 */
export interface LiveEntryDeps {
  liveEnabled(): boolean;
  cfg(userId: string): Promise<{ liveArmed: boolean; dryRun: boolean }>;
  tradeKey(userId: string): Promise<{ key: string; secret: string } | null>;
  positions(key: string, secret: string): Promise<OptionPosition[]>;
  book(symbol: string): Promise<Book>;
  productId(symbol: string): Promise<number>;
  tickOf(symbol: string): number;
  post(key: string, secret: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: any; errorText: string }>;
  /** Cancel one of the stop-loss orders this desk placed (by order id and product). */
  cancel?(key: string, secret: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: any; errorText: string }>;
  log(userId: string, kind: string, detail: string, o: { symbol?: string; dryRun: boolean }): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const roundTick = (price: number, tick: number, dir: 'up' | 'down') => {
  const q = price / tick;
  return (dir === 'up' ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9)) * tick;
};
const fmt = (v: number) => String(Number(v.toFixed(6)));

interface Ref { symbols: string[]; stops?: Array<{ productId: number; id: number }> }
const parseRef = (ref: string): Ref | null => { try { const r = JSON.parse(ref) as Ref; return Array.isArray(r.symbols) ? r : null; } catch { return null; } };

export function makeLiveBroker(d: LiveEntryDeps): Broker {
  /** Why live trading is not allowed right now, or null. */
  async function lock(userId: string): Promise<{ why: string } | { key: string; secret: string; dry: boolean }> {
    const cfg = await d.cfg(userId);
    if (!cfg.liveArmed) return { why: 'live trading is not armed (Settings, Stop alarm and hard exit: save a trading key, then arm)' };
    if (!cfg.dryRun && !d.liveEnabled()) return { why: 'dry-run is off but LIVE_TRADING_ENABLED is not set on the server' };
    const creds = await d.tradeKey(userId);
    if (!creds) return { why: 'no trading key is saved' };
    return { ...creds, dry: cfg.dryRun };
  }

  return {
    async place(userId: string, rule: AlgoStrategy, plan: EntryPlan, name: string): Promise<PlaceResult> {
      if (plan.kind !== 'option') return { ok: false, reason: 'live futures orders are not built yet: run this strategy in Paper mode' };
      const l = await lock(userId);
      if ('why' in l) return { ok: false, reason: l.why };
      const { key, secret, dry } = l;
      try {
        // hedges first (bought legs), then the sold legs, so margin is never worse than the finished structure
        const legs = [...plan.legs].sort((a, b) => (a.side === 'buy' ? 0 : 1) - (b.side === 'buy' ? 0 : 1));
        const orders: Array<{ symbol: string; side: 'buy' | 'sell'; size: number; limit: number; payload: Record<string, unknown> }> = [];
        for (const leg of legs) {
          const book = await d.book(leg.symbol), tick = d.tickOf(leg.symbol) || 0.1;
          const buy = leg.side === 'buy', touch = buy ? book.asks[0]?.[0] : book.bids[0]?.[0];
          if (!touch || !(touch > 0)) return { ok: false, reason: `${leg.symbol}: no ${buy ? 'ask' : 'bid'} in the book` };
          const buffer = Math.max(3 * tick, touch * 0.03);
          const limit = buy ? roundTick(touch + buffer, tick, 'up') : Math.max(tick, roundTick(touch - buffer, tick, 'down'));
          const productId = await d.productId(leg.symbol);
          orders.push({ symbol: leg.symbol, side: leg.side, size: leg.lots, limit, payload: { product_id: productId, size: leg.lots, side: leg.side, order_type: 'limit_order', limit_price: fmt(limit), time_in_force: 'ioc', reduce_only: false } });
        }
        if (dry) {
          for (const o of orders) await d.log(userId, 'algo_entry_dry', `DRY RUN, nothing sent: would ${o.side} ${o.size} ${o.symbol} at limit ${o.limit} (immediate-or-cancel). Strategy: ${name}.`, { symbol: o.symbol, dryRun: true });
          return { ok: true, dry: true, ref: 'dry', detail: `DRY RUN: ${orders.length} orders were written to the event list, nothing was sent to Delta` };
        }
        const before = new Map((await d.positions(key, secret)).map((p) => [p.symbol, p.size]));
        await d.log(userId, 'algo_entry_order', `Entering ${name}: ${orders.length} legs.`, { dryRun: false });
        for (const o of orders) {
          const r = await d.post(key, secret, o.payload);
          await d.log(userId, r.ok ? 'algo_entry_order' : 'algo_entry_failed', `${o.side} ${o.size} ${o.symbol} at limit ${o.limit}: ${r.ok ? 'accepted by Delta' : 'rejected: ' + (r.errorText || r.status)}`, { symbol: o.symbol, dryRun: false });
        }
        await d.sleep(1_500);
        const after = new Map((await d.positions(key, secret)).map((p) => [p.symbol, p]));
        const short: string[] = [];
        for (const o of orders) {
          const moved = ((after.get(o.symbol)?.size ?? 0) - (before.get(o.symbol) ?? 0)) * (o.side === 'buy' ? 1 : -1);
          if (moved < o.size) short.push(`${o.symbol} filled ${Math.max(moved, 0)} of ${o.size}`);
        }
        if (short.length) {
          await d.log(userId, 'algo_entry_failed', `${name}: not every leg filled (${short.join('; ')}). Undoing the legs that did fill.`, { dryRun: false });
          await rollback(userId, key, secret, orders, before, after);
          return { ok: false, reason: `not every leg filled (${short.join('; ')}); the legs that filled were closed again` };
        }
        await d.log(userId, 'algo_entry_done', `${name}: every leg is filled.`, { dryRun: false });
        // the per-leg stop-loss, sent to Delta as a real stop order on each sold leg (a buy that closes it when the mark reaches the stop)
        const mult = rule.exit.legStopMultiple, soldLegs = orders.filter((o) => o.side === 'sell');
        const stops: NonNullable<Ref['stops']> = [], failed: string[] = [];
        if (mult) {
          for (const o of soldLegs) {
            const pos = after.get(o.symbol), tick = d.tickOf(o.symbol) || 0.1;
            if (!pos || !(pos.entry > 0)) { failed.push(`${o.symbol}: no entry price to work the stop from`); continue; }
            const stopPrice = roundTick(pos.entry * mult, tick, 'up');
            const limit = roundTick(Math.max(stopPrice * 1.25, stopPrice + 3 * tick), tick, 'up'); // options take limit orders only: the stop becomes a limit well through the trigger
            const r = await placeStop(d.post, key, secret, { productId: Number(o.payload.product_id), size: Math.abs(pos.size), stopPrice, limitPrice: limit });
            if (r.ok && r.id != null) {
              stops.push({ productId: Number(o.payload.product_id), id: r.id });
              await d.log(userId, 'algo_stop_order', `Stop-loss on Delta (${r.how}): buy ${Math.abs(pos.size)} ${o.symbol} when the price reaches ${fmt(stopPrice)} (${mult}x the sell price ${pos.entry}).`, { symbol: o.symbol, dryRun: false });
            } else {
              failed.push(`${o.symbol}: ${r.errors.join(' | ')}`);
              await d.log(userId, 'algo_stop_failed', `Stop-loss NOT placed on Delta for ${o.symbol}. Delta said: ${r.errors.join(' | ')}. The desk's own ${mult}x check still closes the position.`, { symbol: o.symbol, dryRun: false });
            }
          }
        }
        const stopNote = !mult ? 'No per-leg stop in this rule, so none was sent to Delta.' : `Stop-loss on Delta: ${stops.length} of ${soldLegs.length} sold legs.${failed.length ? ` NOT placed: ${failed.join('; ')}.` : ''}`;
        return { ok: true, ref: JSON.stringify({ symbols: orders.map((o) => o.symbol), stops } satisfies Ref), detail: `${orders.length} legs filled. ${stopNote}` };
      } catch (e) {
        await d.log(userId, 'algo_entry_failed', `${name}: ${(e as Error).message}. Check Delta for open positions.`, { dryRun: dry }).catch(() => undefined);
        return { ok: false, reason: (e as Error).message };
      }
    },

    async status(userId: string, ref: string): Promise<BrokerStatus | null> {
      const r = parseRef(ref);
      const creds = await d.tradeKey(userId);
      if (!r || !creds) return null;
      try {
        const mine = (await d.positions(creds.key, creds.secret)).filter((p) => r.symbols.includes(p.symbol));
        if (!mine.length) return { open: false, netPnl: null, closedReason: 'no open position left in these contracts' };
        let net = 0;
        const legs: NonNullable<BrokerStatus['legs']> = [];
        for (const p of mine) {
          const b = await d.book(p.symbol);
          const bid = b.bids[0]?.[0], ask = b.asks[0]?.[0];
          if (!bid || !ask) return { open: true, netPnl: null };
          const mid = (bid + ask) / 2, pnl = (p.size < 0 ? p.entry - mid : mid - p.entry) * Math.abs(p.size) * 0.001;
          net += pnl;
          legs.push({ symbol: p.symbol, side: p.size < 0 ? 'sell' : 'buy', lots: Math.abs(p.size), entry: p.entry, mark: mid, pnl });
        }
        // some of this run's contracts are gone while others remain: a stop fired (or a leg was closed by hand)
        return { open: true, netPnl: net, legs, legGone: mine.length < r.symbols.length };
      } catch {
        return null;
      }
    },

    async closeAll(userId: string, ref: string, reason: string) {
      const r = parseRef(ref);
      if (!r) return { ok: false, reason: 'bad reference' };
      const l = await lock(userId);
      if ('why' in l) return { ok: false, reason: l.why };
      if (l.dry) return { ok: false, reason: 'dry-run is on, nothing was sent' };
      try {
        const positions = (await d.positions(l.key, l.secret)).filter((p) => r.symbols.includes(p.symbol));
        const books = new Map<string, Book>();
        for (const p of positions) books.set(p.symbol, await d.book(p.symbol));
        const expiries = [...new Set(positions.map((p) => expiryOf(p.symbol)))].filter((e) => OPTION_EXPIRY.test(e));
        for (const ex of expiries) {
          const { orders, problems } = buildClosingOrders(positions, books, d.tickOf, ex, 0);
          for (const pr of problems) await d.log(userId, 'algo_exit_failed', pr, { dryRun: false });
          for (const o of orders) {
            const res = await d.post(l.key, l.secret, o.payload);
            await d.log(userId, res.ok ? 'algo_exit_order' : 'algo_exit_failed', `${reason}: ${o.side} ${o.size} ${o.symbol} at limit ${o.limitPrice}: ${res.ok ? 'accepted' : 'rejected: ' + (res.errorText || res.status)}`, { symbol: o.symbol, dryRun: false });
          }
        }
        // the exchange stops are no longer needed: take them off (a reduce-only stop on a flat position would do nothing, but do not leave them)
        for (const s of r.stops ?? []) {
          const c = await d.cancel?.(l.key, l.secret, { id: s.id, product_id: s.productId }).catch(() => null);
          if (c && !c.ok) await d.log(userId, 'algo_stop_cancel_failed', `Could not cancel stop order ${s.id}: ${c.errorText || c.status} (it may already have fired).`, { dryRun: false });
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
  };

  async function rollback(userId: string, key: string, secret: string, orders: Array<{ symbol: string; side: 'buy' | 'sell'; size: number; payload: Record<string, unknown> }>, before: Map<string, number>, after: Map<string, OptionPosition>) {
    for (const o of orders) {
      const moved = ((after.get(o.symbol)?.size ?? 0) - (before.get(o.symbol) ?? 0)) * (o.side === 'buy' ? 1 : -1);
      if (moved <= 0) continue;
      const book = await d.book(o.symbol), tick = d.tickOf(o.symbol) || 0.1;
      const closeBuy = o.side === 'sell', touch = closeBuy ? book.asks[0]?.[0] : book.bids[0]?.[0];
      if (!touch) { await d.log(userId, 'algo_entry_failed', `${o.symbol}: cannot undo, no ${closeBuy ? 'ask' : 'bid'}. Close it on Delta now.`, { symbol: o.symbol, dryRun: false }); continue; }
      const buffer = Math.max(3 * tick, touch * 0.03) * 3;
      const limit = closeBuy ? roundTick(touch + buffer, tick, 'up') : Math.max(tick, roundTick(touch - buffer, tick, 'down'));
      const res = await d.post(key, secret, { product_id: o.payload.product_id, size: moved, side: closeBuy ? 'buy' : 'sell', order_type: 'limit_order', limit_price: fmt(limit), time_in_force: 'ioc', reduce_only: true });
      await d.log(userId, res.ok ? 'algo_entry_order' : 'algo_entry_failed', `undo ${closeBuy ? 'buy' : 'sell'} ${moved} ${o.symbol}: ${res.ok ? 'accepted' : 'rejected: ' + (res.errorText || res.status)}`, { symbol: o.symbol, dryRun: false });
    }
  }
}

const ticks = new Map<string, number>();
const productIds = new Map<string, number>();

export const realLiveEntryDeps: LiveEntryDeps = {
  liveEnabled: () => process.env.LIVE_TRADING_ENABLED === 'true',
  cfg: (uid) => getWatchConfig(uid, 0),
  tradeKey: (uid) => loadDeltaKey(uid, 'trade'),
  positions: fetchOptionPositions,
  book: (s) => fetchBook(s, 20),
  async productId(symbol) {
    const hit = productIds.get(symbol);
    if (hit) return hit;
    const j = await deltaGet<{ result?: { id?: number } }>(`/v2/products/${encodeURIComponent(symbol)}`);
    const id = Number(j.result?.id);
    if (!Number.isFinite(id)) throw new Error(`Delta has no product ${symbol}`);
    productIds.set(symbol, id);
    return id;
  },
  tickOf: (s) => ticks.get(s) ?? 0.5,
  post: (key, secret, payload) => deltaSignedPost(key, secret, '/v2/orders', payload),
  cancel: (key, secret, payload) => deltaSignedDelete(key, secret, '/v2/orders', payload),
  log: (uid, kind, detail, o) => logWatchEvent(uid, kind, detail, o),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Refresh the tick sizes from the shared market snapshot (called by the engine's market loader). */
export async function refreshTicks(): Promise<void> {
  const snap = await marketFeed().fast();
  for (const r of snap.rows) ticks.set(r.symbol, r.tick);
}

export const liveBroker = makeLiveBroker(realLiveEntryDeps);

/** "exit" in Ask me for real positions: close every BTC option position, expiry by expiry, through the hard-exit path and its locks. */
const killer = new LiveExit(realLiveExitDeps((s) => ticks.get(s) ?? 0.5));
export async function killAllLive(userId: string): Promise<{ sent: boolean; message: string }> {
  const cfg = await getWatchConfig(userId, 0);
  const creds = await loadDeltaKey(userId, 'trade');
  if (!creds) return { sent: false, message: 'No trading key is saved, so no real position can be closed from here.' };
  await refreshTicks().catch(() => undefined);
  const positions = await fetchOptionPositions(creds.key, creds.secret);
  const expiries = [...new Set(positions.map((p) => expiryOf(p.symbol)))];
  if (!expiries.length) return { sent: false, message: 'There are no open BTC option positions on Delta.' };
  const results: string[] = [];
  for (const ex of expiries) {
    const r = await killer.run(userId, { group: ex, label: `Ask me exit, expiry ${ex}`, legs: [] }, { liveArmed: cfg.liveArmed, dryRun: cfg.dryRun });
    results.push(`${ex}: ${r}`);
  }
  const blocked = results.some((x) => x.endsWith('blocked'));
  const dry = results.some((x) => x.endsWith('dry'));
  return { sent: !blocked && !dry, message: blocked ? 'Live trading is locked (arm it in Settings first), so nothing was sent.' : dry ? 'Dry-run is on: the closing orders were written to the event list but NOT sent.' : `Closing orders sent (${results.join(', ')}).` };
}
