/**
 * Fetch historical BTCUSDT OHLCV klines from Binance (public API) and cache to JSON.
 *
 * Usage:
 *   npx tsx src/backtest/data/fetch-binance.ts 15m
 *   npx tsx src/backtest/data/fetch-binance.ts 1m
 *   npx tsx src/backtest/data/fetch-binance.ts            # defaults to 15m
 *
 * Output: src/backtest/data/cache/btc-<interval>.json
 *   Array of [openTimeSec, open, high, low, close, volume] (numbers), chronological.
 *
 * The backtest requires 15m closed candles across the full span; 1m is optional for
 * sharper intra-candle stop-loss timing. Binance returns up to 1000 klines per call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, 'cache');

const BASE = 'https://api.binance.com/api/v3/klines';
const SYMBOL = 'BTCUSDT';

// Span: cover both dexbtusd_1year.json (2025-10-31 → 2026-10-19) and the shadow
// dataset (2025-10-06 → 2026-10-18), with margin.
const START_MS = Date.UTC(2025, 9, 1, 0, 0, 0); // 2025-10-01
const END_MS = Date.UTC(2026, 9, 20, 0, 0, 0); // 2026-10-20

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
};

type Kline = [number, number, number, number, number, number]; // [openSec,o,h,l,c,v]

async function fetchChunk(interval: string, startMs: number): Promise<any[]> {
  const url = `${BASE}?symbol=${SYMBOL}&interval=${interval}&startTime=${startMs}&endTime=${END_MS}&limit=1000`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 || res.status === 418) {
        const wait = 2000 * (attempt + 1);
        console.warn(`[fetch] rate-limited (${res.status}), waiting ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as any[];
    } catch (err: any) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return [];
}

async function fetchInterval(interval: string): Promise<Kline[]> {
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) throw new Error(`Unsupported interval: ${interval}`);

  const out: Kline[] = [];
  let cursor = START_MS;
  let calls = 0;

  while (cursor < END_MS) {
    const rows = await fetchChunk(interval, cursor);
    calls++;
    if (!rows.length) break;

    for (const r of rows) {
      const openMs = Number(r[0]);
      if (openMs >= END_MS) break;
      out.push([
        Math.floor(openMs / 1000),
        parseFloat(r[1]),
        parseFloat(r[2]),
        parseFloat(r[3]),
        parseFloat(r[4]),
        parseFloat(r[5]),
      ]);
    }

    const lastOpen = Number(rows[rows.length - 1][0]);
    cursor = lastOpen + stepMs;
    if (calls % 20 === 0) {
      console.log(`[fetch] ${interval}: ${out.length} candles so far (up to ${new Date(lastOpen).toISOString()})`);
    }
    // Gentle pacing to stay well under Binance weight limits.
    await new Promise((r) => setTimeout(r, 120));
  }

  // De-dup (overlap at page boundaries) and sort chronologically.
  const seen = new Set<number>();
  const dedup = out.filter((k) => (seen.has(k[0]) ? false : (seen.add(k[0]), true)));
  dedup.sort((a, b) => a[0] - b[0]);
  return dedup;
}

function gapReport(candles: Kline[], stepMs: number): { gaps: number; firstGapAt: string | null } {
  let gaps = 0;
  let firstGapAt: string | null = null;
  for (let i = 1; i < candles.length; i++) {
    const dt = (candles[i][0] - candles[i - 1][0]) * 1000;
    if (dt !== stepMs) {
      gaps++;
      if (!firstGapAt) firstGapAt = new Date(candles[i - 1][0] * 1000).toISOString();
    }
  }
  return { gaps, firstGapAt };
}

async function main() {
  const interval = process.argv[2] || '15m';
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs) {
    console.error(`Unsupported interval "${interval}". Use one of: ${Object.keys(INTERVAL_MS).join(', ')}`);
    process.exit(1);
  }

  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`[fetch] ${SYMBOL} ${interval} from ${new Date(START_MS).toISOString()} to ${new Date(END_MS).toISOString()}`);
  const candles = await fetchInterval(interval);

  const outPath = path.join(CACHE_DIR, `btc-${interval}.json`);
  fs.writeFileSync(outPath, JSON.stringify(candles));

  const { gaps, firstGapAt } = gapReport(candles, stepMs);
  const first = candles[0] ? new Date(candles[0][0] * 1000).toISOString() : 'n/a';
  const last = candles[candles.length - 1] ? new Date(candles[candles.length - 1][0] * 1000).toISOString() : 'n/a';
  console.log(`[fetch] DONE ${interval}: ${candles.length} candles`);
  console.log(`[fetch] span: ${first} → ${last}`);
  console.log(`[fetch] gaps (non-contiguous steps): ${gaps}${firstGapAt ? ` (first at ${firstGapAt})` : ''}`);
  console.log(`[fetch] wrote ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error('[fetch] FATAL', err);
  process.exit(1);
});
