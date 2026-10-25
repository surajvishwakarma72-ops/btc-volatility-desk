/**
 * Five years of BTCUSDT 15m candles (Binance) and hourly DVOL (Deribit), cached for the strangle search.
 *
 *   npx tsx src/backtest/data/fetch-5y.ts
 *
 * Output (gitignored): cache/btc-15m-5y.json  [tSec,o,h,l,c,v][]   cache/btc-dvol-1h-5y.json  [tSec,dvol][]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(here, 'cache');
const START = Date.UTC(2021, 9, 20);
const END = Date.UTC(2026, 9, 24);

async function getJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'btc-volatility-desk-backtest' }, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 || r.status === 418) { await new Promise((x) => setTimeout(x, 3000 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((x) => setTimeout(x, 1500 * (attempt + 1)));
    }
  }
}

async function candles(): Promise<number[][]> {
  const out: number[][] = [];
  let t = START;
  while (t < END) {
    const k = (await getJson(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&startTime=${t}&endTime=${END}&limit=1000`)) as any[];
    if (!k.length) break;
    for (const r of k) out.push([Math.floor(r[0] / 1000), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])]);
    t = k[k.length - 1][0] + 900_000;
    if (out.length % 20_000 < 1000) console.log(`candles ${out.length} up to ${new Date(t).toISOString().slice(0, 10)}`);
  }
  return out;
}

async function dvol(): Promise<number[][]> {
  const out = new Map<number, number>();
  const CHUNK = 50 * 86_400_000;
  for (let t = START; t < END; t += CHUNK) {
    const j = await getJson(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${t}&end_timestamp=${Math.min(t + CHUNK, END)}&resolution=3600`);
    for (const r of j?.result?.data ?? []) out.set(Math.floor(r[0] / 1000), Number(r[4]));
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]);
}

const c = await candles();
fs.writeFileSync(path.join(CACHE, 'btc-15m-5y.json'), JSON.stringify(c));
console.log(`15m candles: ${c.length}, ${new Date(c[0]![0] * 1000).toISOString()} -> ${new Date(c[c.length - 1]![0] * 1000).toISOString()}`);
const d = await dvol();
fs.writeFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), JSON.stringify(d));
console.log(`DVOL hourly: ${d.length}, ${new Date(d[0]![0] * 1000).toISOString()} -> ${new Date(d[d.length - 1]![0] * 1000).toISOString()}`);
