/**
 * Minimal data loader for the backtest: Binance 15m/1m candles + archived intraday
 * ATM-IV curves. (Flow/GEX/skew/DVOL loaders are added for later steps.)
 *
 * Price = Binance caches (full span, clean). IV = archive iv-curves.json (per
 * "<expiry>|<day>" minute samples in %), merged per expiry into an absolute-time
 * series and forward-filled via `at()`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN, d0, at } from '../lib/frame.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(__dirname, 'cache');

export interface Bar {
  t: number; // ms (open time)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function readCandles(interval: '15m' | '1m'): Bar[] {
  const p = path.join(CACHE, `btc-${interval}.json`);
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as number[][];
  // [tSec,o,h,l,c,v] -> ms
  return raw.map((r) => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] }));
}

export class BacktestData {
  readonly bars1m: Bar[];
  readonly bars15m: Bar[];
  private c15: Map<number, Bar>;
  private ivCurves: Record<string, [number, number][]>;
  private ivSeriesByExpiry = new Map<string, [number, number][]>();
  private dvolSeries: [number, number][] = [];

  constructor() {
    this.bars1m = readCandles('1m');
    this.bars15m = readCandles('15m');
    this.c15 = new Map(this.bars15m.map((b) => [b.t, b]));
    this.ivCurves = JSON.parse(fs.readFileSync(path.join(CACHE, 'iv-curves.json'), 'utf-8'));
    const dvolPath = path.join(CACHE, 'btc-dvol-1h.json');
    if (fs.existsSync(dvolPath)) {
      const raw = JSON.parse(fs.readFileSync(dvolPath, 'utf-8')) as number[][];
      this.dvolSeries = raw.map((r) => [r[0] * 1000, r[1]] as [number, number]);
    }
  }

  private sliceBars(arr: Bar[], fromMs: number, toMs: number): Bar[] {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < fromMs) lo = m + 1; else hi = m; }
    const out: Bar[] = [];
    for (let i = lo; i < arr.length && arr[i].t <= toMs; i++) out.push(arr[i]);
    return out;
  }

  /** 15m bars with open time in [fromMs, toMs]. */
  bars15mBetween(fromMs: number, toMs: number): Bar[] {
    return this.sliceBars(this.bars15m, fromMs, toMs);
  }

  /** Forward-filled DVOL (%) at time tMs; null if before first sample / unavailable. */
  dvolAt(tMs: number): number | null {
    return at(this.dvolSeries, tMs);
  }

  /** Spot (15m close) exactly at a 15m-grid entry time (ms); null if no candle. */
  entrySpot(tMs: number): number | null {
    const b = this.c15.get(tMs);
    return b ? b.c : null;
  }

  /** 1m bars with open time in [fromMs, toMs], chronological. */
  bars1mBetween(fromMs: number, toMs: number): Bar[] {
    const arr = this.bars1m;
    // binary search first index with t >= fromMs
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m].t < fromMs) lo = m + 1;
      else hi = m;
    }
    const out: Bar[] = [];
    for (let i = lo; i < arr.length && arr[i].t <= toMs; i++) out.push(arr[i]);
    return out;
  }

  /** Merged, sorted absolute-time IV series (%) for a given expiry across all its days. */
  private ivSeries(expiry: string): [number, number][] {
    const cached = this.ivSeriesByExpiry.get(expiry);
    if (cached) return cached;
    const out: [number, number][] = [];
    const prefix = `${expiry}|`;
    for (const key of Object.keys(this.ivCurves)) {
      if (!key.startsWith(prefix)) continue;
      const day = key.slice(prefix.length);
      const base = d0(day);
      for (const [minute, iv] of this.ivCurves[key]) out.push([base + minute * MIN, iv]);
    }
    out.sort((a, b) => a[0] - b[0]);
    this.ivSeriesByExpiry.set(expiry, out);
    return out;
  }

  /** Forward-filled ATM IV (%) for `expiry` at time `tMs`; null if before first sample. */
  ivAt(expiry: string, tMs: number): number | null {
    return at(this.ivSeries(expiry), tMs);
  }

  /** Raw IV samples [tMs, iv%] for `expiry` within [fromMs, toMs], chronological. */
  ivWindow(expiry: string, fromMs: number, toMs: number): [number, number][] {
    return this.ivSeries(expiry).filter(([t]) => t >= fromMs && t <= toMs);
  }

  hasIv(expiry: string): boolean {
    return this.ivSeries(expiry).length > 0;
  }

  get priceFirst(): number {
    return this.bars15m[0].t;
  }
  get priceLast(): number {
    return this.bars15m[this.bars15m.length - 1].t;
  }
}

let _singleton: BacktestData | null = null;
export function loadData(): BacktestData {
  if (!_singleton) _singleton = new BacktestData();
  return _singleton;
}
