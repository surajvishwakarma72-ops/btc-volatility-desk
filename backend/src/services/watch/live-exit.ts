import { deltaSignedGet, deltaSignedPost } from '../../routes/delta.js';
import type { WatchSettings } from '../../lib/watch/classify.js';
import { fetchBook, type Book } from '../bot/delta-public.js';
import { loadOrderKey } from '../delta-keys.js';
import { logWatchEvent } from './watch-store.js';
import type { WatchGroup } from './watch.js';

/**
 * HARD EXIT on real Delta positions. This is the only code in the desk that can send an order to the exchange, so it is built to do as
 * little as possible and to refuse by default:
 *
 *  - it sends only reduce-only, immediate-or-cancel LIMIT orders that close an existing option position (a short is bought back, a long is
 *    sold); it can never open or enlarge a position, and it never touches anything but BTC options;
 *  - every one of these must be true: the server has LIVE_TRADING_ENABLED=true, the user saved a trading key, the user armed it, and the user
 *    turned dry-run off. With dry-run on (the default) it only writes what it WOULD send;
 *  - it closes every option position in the same expiry as the leg that reached the hard-exit distance (both legs of the strangle);
 *  - it is rate limited (one round per 45 s per position group, three tries at wider prices) and every step is written to the event log.
 */
export interface OptionPosition { productId: number; symbol: string; size: number; entry: number }

export const SUPPORTED_OPTION_ASSETS = ['BTC', 'ETH', 'XAUT'] as const;
export type SupportedOptionAsset = (typeof SUPPORTED_OPTION_ASSETS)[number];

export const OPTION_SYMBOL = /^[CP]-(?:BTC|ETH|XAUT)-\d+(?:\.\d+)?-\d{6}$/;
export const expiryOf = (symbol: string): string => symbol.split('-')[3] ?? '';
export const assetOf = (symbol: string): string => symbol.split('-')[1] ?? '';
/** DDMMYY, the expiry part of a Delta option symbol. */
export const OPTION_EXPIRY = /^\d{6}$/;

export interface ClosingOrder {
  symbol: string;
  productId: number;
  side: 'buy' | 'sell';
  size: number;
  limitPrice: number;
  payload: { product_id: number; size: number; side: 'buy' | 'sell'; order_type: 'limit_order'; limit_price: string; time_in_force: 'ioc'; reduce_only: true };
}

const roundTick = (price: number, tick: number, dir: 'up' | 'down'): number => {
  const q = price / tick;
  return (dir === 'up' ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9)) * tick;
};
const fmt = (v: number): string => String(Number(v.toFixed(6)));

/**
 * The closing orders for the positions in one expiry. `attempt` 0, 1, 2 widens how far past the best price the order may go
 * (3 ticks or 3% of the price, times 3 for each retry), so an unfilled first try is followed by a more aggressive one.
 */
export function buildClosingOrders(positions: readonly OptionPosition[], books: ReadonlyMap<string, Book>, tickOf: (s: string) => number, expiry: string, attempt = 0): { orders: ClosingOrder[]; problems: string[] } {
  const orders: ClosingOrder[] = [], problems: string[] = [];
  const mine = positions.filter((p) => OPTION_SYMBOL.test(p.symbol) && expiryOf(p.symbol) === expiry && Number.isInteger(p.size) && p.size !== 0);
  // shorts first: they are the ones that can lose without limit
  mine.sort((a, b) => (a.size < 0 ? 0 : 1) - (b.size < 0 ? 0 : 1));
  for (const p of mine) {
    const fallbackTick = assetOf(p.symbol) === 'BTC' ? 0.1 : 0.01;
    const book = books.get(p.symbol), tick = tickOf(p.symbol) || fallbackTick;
    const buy = p.size < 0, touch = buy ? book?.asks[0]?.[0] : book?.bids[0]?.[0];
    if (!touch || !(touch > 0)) { problems.push(`${p.symbol}: no ${buy ? 'ask' : 'bid'} in the book to close against`); continue; }
    const buffer = Math.max(3 * tick, touch * 0.03) * Math.pow(3, Math.max(0, attempt));
    const limit = buy ? roundTick(touch + buffer, tick, 'up') : Math.max(tick, roundTick(touch - buffer, tick, 'down'));
    const size = Math.abs(p.size);
    orders.push({ symbol: p.symbol, productId: p.productId, side: buy ? 'buy' : 'sell', size, limitPrice: limit, payload: { product_id: p.productId, size, side: buy ? 'buy' : 'sell', order_type: 'limit_order', limit_price: fmt(limit), time_in_force: 'ioc', reduce_only: true } });
  }
  return { orders, problems };
}

export async function fetchOptionPositions(key: string, secret: string): Promise<OptionPosition[]> {
  const r = await deltaSignedGet(key, secret, '/v2/positions/margined', 'contract_types=call_options,put_options');
  if (!r.ok) throw new Error(`Delta refused the positions request (${r.errorText || r.status})`);
  const list = ((r.body as any)?.result ?? []) as any[];
  const out: OptionPosition[] = [];
  for (const p of list) {
    const symbol = String(p.product_symbol ?? p.product?.symbol ?? '');
    const size = Number(p.size), productId = Number(p.product_id ?? p.product?.id), entry = Number(p.entry_price);
    if (OPTION_SYMBOL.test(symbol) && Number.isFinite(size) && size !== 0 && Number.isFinite(productId)) out.push({ productId, symbol, size, entry: Number.isFinite(entry) ? entry : 0 });
  }
  return out;
}

export interface LiveExitDeps {
  liveEnabled(): boolean;
  tradeKey(userId: string): Promise<{ key: string; secret: string } | null>;
  positions(key: string, secret: string): Promise<OptionPosition[]>;
  book(symbol: string): Promise<Book>;
  tickOf(symbol: string): number;
  post(key: string, secret: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: any; errorText: string }>;
  log(userId: string, kind: string, detail: string, opts: { symbol?: string; dryRun: boolean }): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type ExitResult = 'blocked' | 'cooldown' | 'flat' | 'dry' | 'done' | 'incomplete' | 'failed';

export class LiveExit {
  private last = new Map<string, { at: number; tries: number }>();
  private blockedLogged = new Map<string, number>();

  constructor(private readonly d: LiveExitDeps) {}

  /** `opts.market`: close at market (a reduce-only market order first, the marketable limit if Delta refuses it). Used for emergencies: a stop that jumped, or a naked leg. */
  async run(userId: string, group: Pick<WatchGroup, 'group' | 'label' | 'legs'>, cfg: { liveArmed: boolean; dryRun: boolean }, opts: { market?: boolean; reason?: string } = {}): Promise<ExitResult> {
    const d = this.d, expiry = group.group, gk = `${userId}|${expiry}`, now = d.now();
    if (!OPTION_EXPIRY.test(expiry)) { await d.log(userId, 'hard_exit_failed', `${group.label}: the position group "${expiry}" is not an expiry code, so nothing was sent. This is a bug: close the position on Delta yourself.`, { dryRun: cfg.dryRun }); return 'failed'; }
    const trigger = opts.reason ?? group.legs.filter((l) => l.level === 'hard' || l.level === 'breach').map((l) => `${l.symbol} at ${l.mark} (stop ${l.stop}, ${l.pointsLeft == null ? '?' : l.pointsLeft.toFixed(1)} points left)`).join('; ');

    // the locks: armed, a trading key, and for a real order also dry-run off and the server switch on
    const why = !cfg.liveArmed ? 'live exit is not armed' : !cfg.dryRun && !d.liveEnabled() ? 'dry-run is off but LIVE_TRADING_ENABLED is not set on the server' : null;
    const creds = why ? null : await d.tradeKey(userId);
    const block = why ?? (creds ? null : 'no trading key is saved');
    const dry = cfg.dryRun;
    if (block) {
      if (now - (this.blockedLogged.get(gk) ?? 0) > 10 * 60_000) {
        this.blockedLogged.set(gk, now);
        await d.log(userId, 'hard_exit_blocked', `Hard exit distance reached for ${group.label}: ${trigger}. Nothing was sent: ${block}. Alarm only.`, { dryRun: true });
      }
      return 'blocked';
    }

    const prev = this.last.get(gk);
    if (prev && now - prev.at < 45_000) return 'cooldown';
    const tries = prev && now - prev.at < 15 * 60_000 ? prev.tries : 0;
    if (tries >= 3) return 'cooldown';
    this.last.set(gk, { at: now, tries: tries + 1 });

    try {
      const { key, secret } = creds!;
      for (let attempt = 0; attempt < 3; attempt++) {
        const positions = await d.positions(key, secret);
        if (!positions.some((p) => expiryOf(p.symbol) === expiry)) {
          // nothing open in this expiry any more: say so plainly (it is not recorded as a completed exit when this round did not do it)
          await d.log(userId, attempt === 0 ? 'hard_exit_flat' : 'hard_exit_done', attempt === 0 ? `${group.label}: no open option position found in expiry ${expiry} any more (already closed?). Nothing was sent.` : `${group.label}: no open option positions left in this expiry.`, { dryRun: dry });
          return attempt === 0 ? 'flat' : 'done';
        }
        const books = new Map<string, Book>();
        for (const p of positions.filter((x) => expiryOf(x.symbol) === expiry)) books.set(p.symbol, await d.book(p.symbol));
        const { orders, problems } = buildClosingOrders(positions, books, d.tickOf, expiry, attempt);
        for (const pr of problems) await d.log(userId, 'hard_exit_failed', pr, { dryRun: dry });
        if (!orders.length) return 'failed';
        if (dry) {
          for (const o of orders) await d.log(userId, 'hard_exit_dry', `DRY RUN, nothing sent: would ${o.side} ${o.size} ${o.symbol} ${opts.market ? 'at market (a marketable limit of ' + o.payload.limit_price + ' if Delta refuses market)' : 'at limit ' + o.payload.limit_price} (reduce-only). Trigger: ${trigger}.`, { symbol: o.symbol, dryRun: true });
          return 'dry';
        }
        await d.log(userId, 'hard_exit_order', `Hard exit for ${group.label} (attempt ${attempt + 1}). Trigger: ${trigger}.`, { dryRun: false });
        for (const o of orders) {
          if (opts.market && attempt === 0) {
            const m = await d.post(key, secret, { product_id: o.productId, size: o.size, side: o.side, order_type: 'market_order', reduce_only: true });
            await d.log(userId, m.ok ? 'hard_exit_order' : 'hard_exit_failed', `MARKET ${o.side} ${o.size} ${o.symbol}: ${m.ok ? 'accepted by Delta' : 'rejected: ' + (m.errorText || m.status) + ', sending it as a marketable limit instead'}`, { symbol: o.symbol, dryRun: false });
            if (m.ok) continue;
          }
          const r = await d.post(key, secret, o.payload);
          await d.log(userId, r.ok ? 'hard_exit_order' : 'hard_exit_failed', `${o.side} ${o.size} ${o.symbol} at limit ${o.payload.limit_price}: ${r.ok ? 'accepted by Delta' : 'rejected: ' + (r.errorText || r.status)}`, { symbol: o.symbol, dryRun: false });
        }
        await d.sleep(1_500);
        const after = await d.positions(key, secret);
        if (!after.some((p) => expiryOf(p.symbol) === expiry)) {
          await d.log(userId, 'hard_exit_done', `${group.label}: every option position in this expiry is closed.`, { dryRun: false });
          return 'done';
        }
      }
      await d.log(userId, 'hard_exit_failed', `${group.label}: positions are still open after 3 tries. Close them on Delta now.`, { dryRun: false });
      return 'incomplete';
    } catch (e) {
      await d.log(userId, 'hard_exit_failed', `${group.label}: ${(e as Error).message}. Close it on Delta now.`, { dryRun: dry }).catch(() => undefined);
      return 'failed';
    }
  }
}

/** The real thing, wired to Delta and the database. */
export function realLiveExitDeps(tickOf: (symbol: string) => number): LiveExitDeps {
  return {
    liveEnabled: () => process.env.LIVE_TRADING_ENABLED === 'true',
    tradeKey: (uid) => loadOrderKey(uid),
    positions: fetchOptionPositions,
    book: (s) => fetchBook(s, 20),
    tickOf,
    post: (key, secret, payload) => deltaSignedPost(key, secret, '/v2/orders', payload),
    log: (uid, kind, detail, o) => logWatchEvent(uid, kind, detail, o),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  };
}

export type { WatchSettings };
