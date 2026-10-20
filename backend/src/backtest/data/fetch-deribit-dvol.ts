/**
 * Fetch historical BTC DVOL (Deribit Volatility Index) and cache to JSON.
 *
 * Usage: npx tsx src/backtest/data/fetch-deribit-dvol.ts
 * Output: src/backtest/data/cache/btc-dvol-1h.json
 *   Array of [tsSec, dvolClose] (numbers), chronological.
 *
 * Deribit `get_volatility_index_data` returns [[ts, open, high, low, close], ...].
 * Valid `resolution` values are 60 / 3600 / 43200 / 1D only (900 returns HTTP 400).
 * DVOL is a slow daily-scale index, so we request hourly (3600s) and forward-fill to
 * 15m in the loader. We chunk the span to stay within Deribit's per-request point cap.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, 'cache');

const BASE = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const RESOLUTION = 3600; // seconds (hourly; forward-filled to 15m in the loader)
const START_MS = Date.UTC(2025, 9, 1, 0, 0, 0);
const END_MS = Date.UTC(2026, 9, 20, 0, 0, 0);
const CHUNK_MS = 20 * 24 * 60 * 60 * 1000; // 20 days per call (~1920 points at 15m)

async function fetchChunk(startMs: number, endMs: number): Promise<[number, number][]> {
  const url = `${BASE}?currency=BTC&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${RESOLUTION}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'BTC-Volatility-Desk-Backtest' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as any;
      const data = json?.result?.data;
      if (!Array.isArray(data)) return [];
      // [ts, open, high, low, close] -> [tsSec, close]
      return data.map((d: any[]) => [Math.floor(Number(d[0]) / 1000), parseFloat(d[4])] as [number, number]);
    } catch (err: any) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return [];
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`[dvol] BTC DVOL ${new Date(START_MS).toISOString()} → ${new Date(END_MS).toISOString()} @ ${RESOLUTION}s`);

  const all: [number, number][] = [];
  for (let s = START_MS; s < END_MS; s += CHUNK_MS) {
    const e = Math.min(s + CHUNK_MS, END_MS);
    const rows = await fetchChunk(s, e);
    all.push(...rows);
    await new Promise((r) => setTimeout(r, 150));
  }

  // De-dup + sort + drop non-finite.
  const seen = new Set<number>();
  const out = all
    .filter((r) => Number.isFinite(r[1]) && (seen.has(r[0]) ? false : (seen.add(r[0]), true)))
    .sort((a, b) => a[0] - b[0]);

  const outPath = path.join(CACHE_DIR, 'btc-dvol-1h.json');
  fs.writeFileSync(outPath, JSON.stringify(out));

  const first = out[0] ? new Date(out[0][0] * 1000).toISOString() : 'n/a';
  const last = out[out.length - 1] ? new Date(out[out.length - 1][0] * 1000).toISOString() : 'n/a';
  console.log(`[dvol] DONE: ${out.length} points, span ${first} → ${last}`);
  console.log(`[dvol] wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error('[dvol] FATAL', err);
  process.exit(1);
});
