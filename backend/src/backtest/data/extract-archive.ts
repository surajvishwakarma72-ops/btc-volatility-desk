/**
 * One-time extraction of the intraday ATM-IV curves from the 479 MB
 * `browser-data-export.json` into a compact, fast-loading cache.
 *
 * Source: exportBundle.indexedDB.suraj_archive_v1.stores.iv
 *   records: { key:"<expiry>|<day>", value:{ e, day, c:{minute->fracIV}, ... } }
 *   `c` is an object with numeric minute keys 0..1439, SPARSE (~hourly, 16-24 pts/day).
 *   Values are fractions (0.36 => 36% IV): scale raw<5 -> raw*100.
 *
 * Usage (needs a big heap for the 479 MB parse):
 *   NODE_OPTIONS=--max-old-space-size=8192 npx tsx src/backtest/data/extract-archive.ts
 *
 * Output: src/backtest/data/cache/iv-curves.json -> { "<e>|<day>": [[minute, ivPct], ...] }
 *         src/backtest/data/cache/iv-meta.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, 'cache');
const EXPORT_PATH = path.resolve(__dirname, '../../../browser-data-export.json');

function main() {
  if (!fs.existsSync(EXPORT_PATH)) {
    console.error(`[extract] missing ${EXPORT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`[extract] reading ${(fs.statSync(EXPORT_PATH).size / 1024 / 1024).toFixed(0)} MB export...`);
  const bundle = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf-8'));
  const ivStore: any[] = bundle?.indexedDB?.suraj_archive_v1?.stores?.iv || [];
  console.log(`[extract] suraj_archive_v1.iv records: ${ivStore.length}`);

  const curves: Record<string, [number, number][]> = {};
  const expiries = new Set<string>();
  const days = new Set<string>();
  let totalPts = 0;

  for (const item of ivStore) {
    const v = item.value || item;
    if (!v || !v.e || !v.day || !v.c || typeof v.c !== 'object') continue;
    const pairs: [number, number][] = [];
    for (const [k, raw] of Object.entries(v.c)) {
      const minute = Number(k);
      const val = raw as any;
      if (!Number.isFinite(minute) || val == null || !Number.isFinite(Number(val)) || Number(val) <= 0) continue;
      const num = Number(val);
      pairs.push([minute, num < 5 ? num * 100 : num]); // fraction -> %
    }
    if (!pairs.length) continue;
    pairs.sort((a, b) => a[0] - b[0]);
    curves[`${v.e}|${v.day}`] = pairs;
    expiries.add(v.e);
    days.add(v.day);
    totalPts += pairs.length;
  }

  const outPath = path.join(CACHE_DIR, 'iv-curves.json');
  fs.writeFileSync(outPath, JSON.stringify(curves));
  const sortedDays = [...days].sort();
  fs.writeFileSync(
    path.join(CACHE_DIR, 'iv-meta.json'),
    JSON.stringify(
      {
        curves: Object.keys(curves).length,
        totalPoints: totalPts,
        avgPtsPerCurve: +(totalPts / Math.max(1, Object.keys(curves).length)).toFixed(1),
        expiries: [...expiries].sort(),
        dayFirst: sortedDays[0] || null,
        dayLast: sortedDays[sortedDays.length - 1] || null,
        dayCount: sortedDays.length,
      },
      null,
      2,
    ),
  );

  console.log(`[extract] curves: ${Object.keys(curves).length}, points: ${totalPts} (~${(totalPts / Math.max(1, Object.keys(curves).length)).toFixed(1)}/curve)`);
  console.log(`[extract] day span: ${sortedDays[0]} → ${sortedDays[sortedDays.length - 1]} (${sortedDays.length} days)`);
  console.log(`[extract] wrote ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
}

main();
