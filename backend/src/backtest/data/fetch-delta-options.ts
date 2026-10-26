/**
 * Real historical option prices from Delta Exchange India (the exchange the desk trades on).
 *
 *   npx tsx src/backtest/data/fetch-delta-options.ts
 *
 * Phase 1: every expired BTC option product (symbol, strike, type, expiry), paged, resumable.
 * Phase 2: for each expiry, the 15 minute MARK price candles (open, high, low, close) of every strike near the money, for the 2 days in which
 *          that expiry is the THIRD listed one (the "2DTE" the desk sells) plus the next day (the longest hold we test).
 *          Newest expiry first, one file per expiry, resumable (a finished file is never fetched again).
 *
 * Output (gitignored): cache/delta/products.json, cache/delta/x-<YYYYMMDD>.json
 * Mark price is the exchange's own mark of that option every 15 minutes: real data, not a model. What it is not: quotes. Bid/ask history is not
 * published, so the spread is an assumption in the backtest (see backtest-timing.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, 'cache/delta');
fs.mkdirSync(OUT, { recursive: true });
const BASE = 'https://api.india.delta.exchange';
const DAY = 86_400_000;
const CONC = Number(process.env.CONC ?? 6);

async function getJson(pathq: string): Promise<any> {
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const r = await fetch(BASE + pathq, { headers: { 'User-Agent': 'btc-volatility-desk-backtest' }, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429) { await new Promise((x) => setTimeout(x, 4000 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (attempt === 6) throw e;
      await new Promise((x) => setTimeout(x, 1200 * (attempt + 1)));
    }
  }
}

interface Prod { s: string; k: number; t: 'C' | 'P'; ex: number }

async function products(): Promise<Prod[]> {
  const file = path.join(OUT, 'products.json');
  let state: { items: Prod[]; after: string | null; done: boolean } = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { items: [], after: null, done: false };
  if (state.done) return state.items;
  const seen = new Set(state.items.map((x) => x.s));
  for (let page = 0; page < 5000; page++) {
    const p = await getJson('/v2/products?contract_types=call_options,put_options&underlying_asset_symbols=BTC&states=expired&page_size=100' + (state.after ? '&after=' + encodeURIComponent(state.after) : ''));
    const rows = p?.result ?? [];
    for (const x of rows) {
      if (seen.has(x.symbol)) continue; seen.add(x.symbol);
      state.items.push({ s: x.symbol, k: Number(x.strike_price), t: x.contract_type === 'call_options' ? 'C' : 'P', ex: Date.parse(x.settlement_time) });
    }
    state.after = p?.meta?.after ?? null;
    if (!rows.length || !state.after) { state.done = true; }
    if (page % 10 === 0 || state.done) { fs.writeFileSync(file, JSON.stringify(state)); console.log(`products page ${page}: ${state.items.length}, last expiry ${new Date(state.items[state.items.length - 1]!.ex).toISOString().slice(0, 10)}`); }
    if (state.done) break;
  }
  fs.writeFileSync(file, JSON.stringify(state));
  return state.items;
}

function spotLookup(): (ms: number) => number | null {
  const raw = JSON.parse(fs.readFileSync(path.resolve(here, 'cache/btc-15m-5y.json'), 'utf8')) as number[][];
  const m = new Map<number, number>();
  for (const r of raw) m.set(r[0]! * 1000, r[4]!);
  const last = raw[raw.length - 1]![0]! * 1000;
  return (ms) => (ms > last ? null : m.get(Math.floor(ms / 900_000) * 900_000) ?? null);
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]!; await fn(x); } }));
}

const all = await products();
console.log('products total', all.length);
const spot = spotLookup();
const byEx = new Map<number, Prod[]>();
for (const p of all) (byEx.get(p.ex) ?? byEx.set(p.ex, []).get(p.ex)!).push(p);
const expiries = [...byEx.keys()].sort((a, b) => b - a);
let done = 0, skipped = 0;
for (const ex of expiries) {
  const tag = new Date(ex).toISOString().slice(0, 10).replace(/-/g, '');
  const file = path.join(OUT, `x-${tag}.json`);
  if (fs.existsSync(file)) { done++; continue; }
  // the window in which this expiry is the third listed one, plus a day to hold
  const from = ex - 3 * DAY - 3_600_000, to = ex - DAY;
  const s0 = spot(from + 3_600_000), s1 = spot(to - 900_000);
  if (s0 == null || s1 == null) { skipped++; continue; }
  const mid = (s0 + s1) / 2;
  // only strikes a seller could pick: within 11% of the spot of that time
  const near = byEx.get(ex)!.filter((p) => Math.abs(p.k / mid - 1) <= 0.11);
  const rows: Array<{ s: string; k: number; t: string; t0: number; o: number[]; h: number[]; l: number[]; c: number[] }> = [];
  await pool(near, CONC, async (p) => {
    const st = Math.floor(from / 1000), en = Math.floor(to / 1000);
    const j = await getJson(`/v2/history/candles?resolution=15m&symbol=${encodeURIComponent('MARK:' + p.s)}&start=${st}&end=${en}`);
    const cs = (j?.result ?? []) as Array<{ time: number; open: number; high: number; low: number; close: number }>;
    if (!cs.length) return;
    cs.sort((a, b) => a.time - b.time);
    // dense arrays on a 15 minute grid from the first candle; gaps stay null
    const t0 = cs[0]!.time, n = Math.floor((cs[cs.length - 1]!.time - t0) / 900) + 1;
    const o: Array<number | null> = new Array(n).fill(null), h = o.slice(), l = o.slice(), c = o.slice();
    for (const x of cs) { const i = Math.round((x.time - t0) / 900); o[i] = x.open; h[i] = x.high; l[i] = x.low; c[i] = x.close; }
    rows.push({ s: p.s, k: p.k, t: p.t, t0, o: o as number[], h: h as number[], l: l as number[], c: c as number[] });
  });
  fs.writeFileSync(file, JSON.stringify({ ex, rows }));
  done++;
  console.log(`expiry ${tag}: ${rows.length}/${near.length} strikes fetched (${done}/${expiries.length} expiries, ${skipped} skipped)`);
}
console.log('finished');
