import type { Instrument } from '../../lib/bot/paper-terminal.js';
import { DEFAULT_PERP, deltaGet, fetchBook, fetchOptionFeeRates, fetchPerpInfo, parseExpiry, type Book, type DeltaTicker } from '../bot/delta-public.js';

/**
 * Live market data for the Paper Trade terminal: the BTC option board (bid, ask, sizes, IV, greeks, open
 * interest), the perpetual's quote, per-contract fee rates, and L2 order books. Public Delta endpoints only.
 */
export interface BoardRow {
  symbol: string;
  type: 'call' | 'put';
  strike: number;
  expiryMs: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mark: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  oi: number;
  volume: number;
}

export interface PerpQuote {
  symbol: string;
  mark: number;
  bid: number;
  ask: number;
  last: number;
  funding: number | null;
  oi: number | null;
}

export interface MarketSnapshot {
  at: number;
  spot: number;
  perp: PerpQuote;
  rows: BoardRow[];
  expiries: number[];
  insts: Map<string, Instrument>;
}

export interface MarketProvider {
  snapshot(maxAgeMs?: number): Promise<MarketSnapshot>;
  book(symbol: string): Promise<Book>;
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

export function parseBoardRow(t: DeltaTicker & { oi?: string; volume?: number | string }): BoardRow | null {
  const symbol = t.symbol;
  const type = t.contract_type === 'call_options' ? 'call' : t.contract_type === 'put_options' ? 'put' : null;
  const expiryMs = symbol ? parseExpiry(symbol) : null;
  const strike = num(t.strike_price);
  if (!symbol || !type || expiryMs == null || !strike) return null;
  return {
    symbol, type, strike, expiryMs,
    bid: num(t.quotes?.best_bid), ask: num(t.quotes?.best_ask), bidSize: num(t.quotes?.bid_size), askSize: num(t.quotes?.ask_size),
    mark: num(t.mark_price),
    // Delta quotes IV as a fraction; the desk shows vol points.
    iv: num(t.quotes?.mark_iv) * 100,
    delta: num(t.greeks?.delta), gamma: num(t.greeks?.gamma), theta: num(t.greeks?.theta), vega: num(t.greeks?.vega),
    oi: num(t.oi), volume: num(t.volume),
  };
}

export class DeltaMarket implements MarketProvider {
  private snap: MarketSnapshot | null = null;
  private pending: Promise<MarketSnapshot> | null = null;
  private fees = new Map<string, { at: number; rates: Awaited<ReturnType<typeof fetchOptionFeeRates>> }>();
  private perpInfo: { at: number; info: Awaited<ReturnType<typeof fetchPerpInfo>> } | null = null;

  async snapshot(maxAgeMs = 3_000): Promise<MarketSnapshot> {
    if (this.snap && Date.now() - this.snap.at < maxAgeMs) return this.snap;
    if (!this.pending) {
      this.pending = this.load().then((s) => (this.snap = s)).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  book(symbol: string): Promise<Book> {
    return fetchBook(symbol);
  }

  private async load(): Promise<MarketSnapshot> {
    const now = Date.now();
    const [calls, puts, perpRes] = await Promise.all([
      deltaGet<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=call_options&underlying_asset_symbols=BTC'),
      deltaGet<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=put_options&underlying_asset_symbols=BTC'),
      deltaGet<{ result?: Record<string, any> }>('/v2/tickers/BTCUSD'),
    ]);
    const raw = [...(calls.result ?? []), ...(puts.result ?? [])];
    const rows = raw.map((t) => parseBoardRow(t)).filter((r): r is BoardRow => !!r && r.expiryMs > now);
    const p = perpRes.result ?? {};
    const spot = num(p.spot_price) || num(p.mark_price);
    if (!spot) throw new Error('Delta returned no BTC price');
    const info = await this.getPerpInfo();
    const perp: PerpQuote = {
      symbol: info.symbol,
      mark: num(p.mark_price) || spot,
      bid: num(p.quotes?.best_bid) || num(p.mark_price),
      ask: num(p.quotes?.best_ask) || num(p.mark_price),
      last: num(p.close) || num(p.mark_price),
      funding: p.funding_rate != null ? num(p.funding_rate) : null,
      oi: p.oi != null ? num(p.oi) : null,
    };
    const rates = await this.getFees(rows.map((r) => r.symbol));
    const insts = new Map<string, Instrument>();
    insts.set(info.symbol, {
      symbol: info.symbol, kind: 'perp', contractValue: info.contractValue, takerRate: info.takerRate, makerRate: info.makerRate,
      premiumCapRate: 0, tick: info.tick, maxLeverage: info.maxLeverage,
    });
    for (const r of rows) {
      const f = rates.get(r.symbol);
      insts.set(r.symbol, {
        symbol: r.symbol, kind: 'option', contractValue: f?.contractValue ?? 0.001, takerRate: f?.takerRate ?? 0.0001, makerRate: f?.makerRate ?? 0.0001,
        premiumCapRate: f?.premiumCapRate ?? 0.035, tick: 5, maxLeverage: 1, option: { type: r.type, strike: r.strike, expiryMs: r.expiryMs, iv: r.iv },
      });
    }
    return { at: now, spot, perp, rows, expiries: [...new Set(rows.map((r) => r.expiryMs))].sort((a, b) => a - b), insts };
  }

  private async getPerpInfo() {
    if (this.perpInfo && Date.now() - this.perpInfo.at < 3_600_000) return this.perpInfo.info;
    const info = await fetchPerpInfo(DEFAULT_PERP.symbol);
    this.perpInfo = { at: Date.now(), info };
    return info;
  }

  private async getFees(symbols: string[]) {
    const hit = this.fees.get('all');
    if (hit && Date.now() - hit.at < 600_000) return hit.rates;
    const rates = await fetchOptionFeeRates(symbols);
    this.fees.set('all', { at: Date.now(), rates });
    return rates;
  }
}
