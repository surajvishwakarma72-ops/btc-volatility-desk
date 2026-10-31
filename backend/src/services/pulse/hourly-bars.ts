import { REGIME_GATE_CONFIG } from '../../lib/pulse/config.js';
import type { Bar1h } from '../../lib/pulse/regime/indicators.js';

const HOUR_MS = 3_600_000;
const PAGE = 1000;
const REFRESH_BARS = 24;
const STALE_MS = 24 * HOUR_MS;
const AFTER_HOUR_MS = 20_000;
const RETRY_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const KLINES_URL = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h';

const errText = (e: unknown): string => {
  const err = e as { message?: string; code?: string; name?: string } | null;
  return err?.message || err?.code || err?.name || String(e);
};

/** Binance rows `[openTimeMs, open, high, low, close, ...]` with string numbers. Malformed rows are dropped; result ascending. */
export function parseKlines(raw: unknown): Bar1h[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar1h[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    if (!row.slice(0, 5).every((x) => typeof x === 'string' || typeof x === 'number')) continue;
    const t = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    if (![t, o, h, l, c].every((x) => Number.isFinite(x) && x > 0) || h < l) continue;
    out.push({ t, o, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** A later bar replaces an earlier one with the same open time (a forming bar becomes its final version). */
export function mergeBars(store: Map<number, Bar1h>, incoming: readonly Bar1h[]): void {
  for (const b of incoming) store.set(b.t, b);
}

export interface HourlyBarsDeps {
  fetchKlines(endTimeMs: number | null, limit: number): Promise<Bar1h[]>;
  now(): number;
}

async function defaultFetchKlines(endTimeMs: number | null, limit: number): Promise<Bar1h[]> {
  const url = `${KLINES_URL}&limit=${limit}${endTimeMs === null ? '' : `&endTime=${endTimeMs}`}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`binance klines HTTP ${res.status}`);
  return parseKlines(await res.json());
}

export interface HourlyBarsOptions {
  backfillBars: number;
  barsKept: number;
}

/**
 * In-memory hourly BTC bars from Binance public klines, for the read-only regime gate.
 * Public data only, no key. Failures keep the bars already held and surface through status().
 */
export class HourlyBars {
  private readonly deps: HourlyBarsDeps;
  private readonly opts: HourlyBarsOptions;
  private readonly store = new Map<number, Bar1h>();
  private lastOkAt: number | null = null;
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Whether the last backfill reached its target or the end of the exchange's history. */
  private backfillComplete = false;
  /** Bumped by start and stop so a cycle still in flight can tell it was superseded. */
  private generation = 0;

  constructor(deps: Partial<HourlyBarsDeps> = {}, opts: Partial<HourlyBarsOptions> = {}) {
    this.deps = { fetchKlines: defaultFetchKlines, now: () => Date.now(), ...deps };
    this.opts = {
      backfillBars: opts.backfillBars ?? REGIME_GATE_CONFIG.backfillBars,
      barsKept: opts.barsKept ?? REGIME_GATE_CONFIG.barsKept,
    };
  }

  /**
   * Page backwards from now until enough bars are held or the exchange has no more. Never throws.
   * Complete = reached backfillBars, or a later page was empty. Anything else (error, empty first page, a page that
   * does not advance, the page cap) is incomplete: lastError stays set and refresh() will backfill again.
   */
  async backfill(): Promise<void> {
    const target = this.opts.backfillBars;
    const maxPages = Math.ceil(target / PAGE) + 3;
    let complete = false;
    let failure: string | null = null;
    try {
      let endTime: number | null = null;
      for (let n = 0; n < maxPages; n++) {
        const page = this.finished(await this.deps.fetchKlines(endTime, PAGE));
        if (page.length === 0) {
          if (n === 0) failure = 'empty first page from klines';
          else complete = true;
          break;
        }
        const before = this.store.size;
        mergeBars(this.store, page);
        if (this.store.size >= target) { complete = true; break; }
        // the first page may overlap bars held from an earlier partial run; later pages must add something
        if (n > 0 && this.store.size === before) break;
        const next = Math.min(...page.map((b) => b.t)) - 1;
        if (endTime !== null && next >= endTime) break;
        endTime = next;
      }
    } catch (e) {
      failure = errText(e);
    }
    this.backfillComplete = complete;
    if (complete) this.markOk();
    else this.lastError = failure ?? `incomplete backfill: ${this.store.size} of ${target} bars`;
    this.prune();
  }

  /**
   * Re-fetch the last 24 bars. A cache that is empty or older than 24 hours is cleared and rebuilt by backfill (no hole
   * in the middle); one whose last backfill did not complete is backfilled again. Never throws.
   */
  async refresh(): Promise<void> {
    const newest = this.newestOpenMs();
    if (newest === null || this.deps.now() - newest > STALE_MS) {
      this.store.clear();
      return this.backfill();
    }
    if (!this.backfillComplete) return this.backfill();
    try {
      const bars = this.finished(await this.deps.fetchKlines(null, REFRESH_BARS));
      if (bars.length === 0) throw new Error('empty response from klines');
      mergeBars(this.store, bars);
      this.markOk();
    } catch (e) {
      this.lastError = errText(e);
    }
    this.prune();
  }

  /** Bars whose hour has ended by `nowMs`, ascending, at most the newest `barsKept`. */
  completed(nowMs: number): Bar1h[] {
    const done = [...this.store.values()].filter((b) => b.t + HOUR_MS <= nowMs).sort((a, b) => a.t - b.t);
    return done.length > this.opts.barsKept ? done.slice(done.length - this.opts.barsKept) : done;
  }

  status(): { count: number; newestOpenMs: number | null; lastOkAt: number | null; lastError: string | null } {
    return { count: this.store.size, newestOpenMs: this.newestOpenMs(), lastOkAt: this.lastOkAt, lastError: this.lastError };
  }

  /** Backfill once in the background, then refresh at 20 s past each hour (every minute while the last hour's bar is missing). */
  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    void this.backfill().then(() => this.schedule(generation));
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private schedule(generation: number): void {
    if (generation !== this.generation) return;
    const now = this.deps.now();
    const caughtUp = this.newestCompletedOpen(now) === Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
    const wait = caughtUp ? (Math.floor(now / HOUR_MS) + 1) * HOUR_MS + AFTER_HOUR_MS - now : RETRY_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().then(() => this.schedule(generation), () => this.schedule(generation));
    }, wait);
    this.timer.unref?.();
  }

  /** Binance returns the still-forming bar without an endTime; only bars whose hour has ended may be stored. */
  private finished(bars: readonly Bar1h[]): Bar1h[] {
    const now = this.deps.now();
    return bars.filter((b) => b.t + HOUR_MS <= now);
  }

  private newestOpenMs(): number | null {
    let max: number | null = null;
    for (const t of this.store.keys()) if (max === null || t > max) max = t;
    return max;
  }

  private newestCompletedOpen(nowMs: number): number | null {
    let max: number | null = null;
    for (const t of this.store.keys()) if (t + HOUR_MS <= nowMs && (max === null || t > max)) max = t;
    return max;
  }

  private markOk(): void {
    this.lastOkAt = this.deps.now();
    this.lastError = null;
  }

  /** Keep memory bounded: the newest barsKept plus a day of slack. */
  private prune(): void {
    const limit = this.opts.barsKept + REFRESH_BARS;
    if (this.store.size <= limit) return;
    const keys = [...this.store.keys()].sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - limit)) this.store.delete(k);
  }
}

export const hourlyBars = new HourlyBars();
