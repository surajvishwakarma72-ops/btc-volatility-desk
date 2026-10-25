import type { BookLevel } from '../../lib/bot/costs.js';
import type { Bar } from '../../lib/bot/futures.js';
import type { ChainOption } from '../../lib/bot/strike-picker.js';

/**
 * Public (unauthenticated) Delta Exchange India market data for the bot: option chain with
 * greeks and quotes, L2 books, and per-product fee rates. Nothing here can place orders.
 */
const BASE = process.env.DELTA_BOT_BASE_URL || 'https://api.india.delta.exchange';

export interface DeltaTicker {
  symbol?: string;
  contract_type?: string;
  strike_price?: string;
  mark_price?: string;
  spot_price?: string;
  greeks?: { delta?: string; gamma?: string; theta?: string; vega?: string; spot?: string } | null;
  quotes?: { best_bid?: string; best_ask?: string; mark_iv?: string; bid_size?: string; ask_size?: string } | null;
  product_id?: number;
}

export interface ChainSnapshot {
  fetchedAt: number;
  spot: number;
  options: ChainOption[];
  /** Raw greeks by symbol for the minute recorder. */
  greeks: Map<string, { delta: number; gamma: number; theta: number; vega: number }>;
  /** Sorted future expiries (epoch ms). */
  expiries: number[];
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Delta option symbols look like `C-BTC-99000-271126`: type, underlying, strike, DDMMYY.
 * Daily options settle at 12:00 UTC (17:30 IST).
 */
export function parseExpiry(symbol: string): number | null {
  const tail = symbol.split('-').pop() ?? '';
  if (!/^\d{6}$/.test(tail)) return null;
  const dd = Number(tail.slice(0, 2));
  const mm = Number(tail.slice(2, 4));
  const yy = Number(tail.slice(4, 6));
  const ms = Date.UTC(2000 + yy, mm - 1, dd, 12, 0, 0);
  return Number.isFinite(ms) ? ms : null;
}

export function parseTicker(t: DeltaTicker): (ChainOption & { gamma: number; theta: number; vega: number }) | null {
  const symbol = t.symbol;
  if (!symbol || !t.contract_type) return null;
  const type = t.contract_type === 'call_options' ? 'call' : t.contract_type === 'put_options' ? 'put' : null;
  const expiryMs = parseExpiry(symbol);
  const strike = num(t.strike_price);
  const delta = num(t.greeks?.delta);
  if (!type || expiryMs == null || !Number.isFinite(strike) || !Number.isFinite(delta)) return null;
  const bid = num(t.quotes?.best_bid);
  const ask = num(t.quotes?.best_ask);
  const mark = num(t.mark_price);
  return {
    symbol,
    type,
    strike,
    expiryMs,
    delta: Math.abs(delta),
    bid: Number.isFinite(bid) ? bid : 0,
    ask: Number.isFinite(ask) ? ask : 0,
    mark: Number.isFinite(mark) ? mark : 0,
    // Delta quotes IV as a fraction (0.375); the desk works in vol points.
    iv: num(t.quotes?.mark_iv) * 100,
    gamma: num(t.greeks?.gamma),
    theta: num(t.greeks?.theta),
    vega: num(t.greeks?.vega),
  };
}

async function getJson<T>(path: string, timeoutMs = 12_000): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': 'btc-volatility-desk-bot', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Delta ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchChain(nowMs = Date.now()): Promise<ChainSnapshot> {
  const [calls, puts] = await Promise.all([
    getJson<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=call_options&underlying_asset_symbols=BTC'),
    getJson<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=put_options&underlying_asset_symbols=BTC'),
  ]);
  const raw = [...(calls.result ?? []), ...(puts.result ?? [])];
  const options: ChainOption[] = [];
  const greeks = new Map<string, { delta: number; gamma: number; theta: number; vega: number }>();
  let spot = NaN;
  for (const t of raw) {
    const p = parseTicker(t);
    if (!p || p.expiryMs <= nowMs) continue;
    const { gamma, theta, vega, ...opt } = p;
    options.push(opt);
    const signedDelta = num(t.greeks?.delta);
    greeks.set(opt.symbol, { delta: signedDelta, gamma, theta, vega });
    if (!Number.isFinite(spot)) spot = num(t.spot_price ?? t.greeks?.spot);
  }
  if (!Number.isFinite(spot)) throw new Error('Delta chain returned no spot price');
  const expiries = [...new Set(options.map((o) => o.expiryMs))].sort((a, b) => a - b);
  return { fetchedAt: nowMs, spot, options, greeks, expiries };
}

export interface Book {
  /** Bids best-first (descending price). */
  bids: BookLevel[];
  /** Asks best-first (ascending price). */
  asks: BookLevel[];
}

export async function fetchBook(symbol: string, depth = 40): Promise<Book> {
  const j = await getJson<{ result?: { buy?: Array<{ price: string; size: number }>; sell?: Array<{ price: string; size: number }> } }>(
    `/v2/l2orderbook/${encodeURIComponent(symbol)}?depth=${depth}`,
  );
  const lv = (a?: Array<{ price: string; size: number }>): BookLevel[] =>
    (a ?? []).map((l) => [Number(l.price), Number(l.size)] as const).filter(([p, s]) => p > 0 && s > 0);
  return { bids: lv(j.result?.buy), asks: lv(j.result?.sell) };
}

export interface FeeRates {
  takerRate: number;
  makerRate: number;
  premiumCapRate: number;
  contractValue: number;
}

export const DEFAULT_OPTION_FEES: FeeRates = { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 };

/** Fee rates read from the products API (never hardcoded beyond this fallback). */
export async function fetchOptionFeeRates(symbols: string[]): Promise<Map<string, FeeRates>> {
  const out = new Map<string, FeeRates>();
  try {
    const j = await getJson<{
      result?: Array<{
        symbol: string;
        taker_commission_rate?: string;
        maker_commission_rate?: string;
        contract_value?: string;
        product_specs?: { premium_commission_rate?: number };
      }>;
    }>('/v2/products?contract_types=call_options,put_options&underlying_asset_symbols=BTC&states=live&page_size=500', 20_000);
    for (const p of j.result ?? []) {
      if (!symbols.includes(p.symbol)) continue;
      out.set(p.symbol, {
        takerRate: num(p.taker_commission_rate) || DEFAULT_OPTION_FEES.takerRate,
        makerRate: num(p.maker_commission_rate) || DEFAULT_OPTION_FEES.makerRate,
        premiumCapRate: num(p.product_specs?.premium_commission_rate) || DEFAULT_OPTION_FEES.premiumCapRate,
        contractValue: num(p.contract_value) || DEFAULT_OPTION_FEES.contractValue,
      });
    }
  } catch {
    /* fall back to defaults per symbol below */
  }
  for (const s of symbols) if (!out.has(s)) out.set(s, DEFAULT_OPTION_FEES);
  return out;
}

/** 1m (or other) candles for a symbol, oldest first. Delta returns newest first, open time in seconds. */
export async function fetchCandles(symbol: string, resolution: '1m' | '5m' | '15m', startSec: number, endSec: number): Promise<Bar[]> {
  const j = await getJson<{ result?: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> }>(
    `/v2/history/candles?resolution=${resolution}&symbol=${encodeURIComponent(symbol)}&start=${startSec}&end=${endSec}`,
    20_000,
  );
  return (j.result ?? [])
    .map((c) => ({ t: c.time * 1000, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume }))
    .sort((a, b) => a.t - b.t);
}

export interface PerpInfo {
  symbol: string;
  contractValue: number;
  takerRate: number;
  makerRate: number;
  maxLeverage: number;
  tick: number;
}

export const DEFAULT_PERP: PerpInfo = { symbol: 'BTCUSD', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, maxLeverage: 200, tick: 0.5 };

/** Contract size and fee rates for the BTC perpetual, from the products API. */
export async function fetchPerpInfo(symbol = 'BTCUSD'): Promise<PerpInfo> {
  try {
    const j = await getJson<{
      result?: { symbol: string; contract_value?: string; taker_commission_rate?: string; maker_commission_rate?: string; default_leverage?: string; tick_size?: string };
    }>(`/v2/products/${encodeURIComponent(symbol)}`);
    const r = j.result;
    if (!r) return DEFAULT_PERP;
    return {
      symbol: r.symbol,
      contractValue: num(r.contract_value) || DEFAULT_PERP.contractValue,
      takerRate: num(r.taker_commission_rate) || DEFAULT_PERP.takerRate,
      makerRate: num(r.maker_commission_rate) || DEFAULT_PERP.makerRate,
      maxLeverage: num(r.default_leverage) || DEFAULT_PERP.maxLeverage,
      tick: num(r.tick_size) || DEFAULT_PERP.tick,
    };
  } catch {
    return DEFAULT_PERP;
  }
}
