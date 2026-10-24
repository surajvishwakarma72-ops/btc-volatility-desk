/**
 * Rebuild btc-dvol-5y-1h.json (hourly DVOL close) from Deribit in 14-day windows, so no hour is missing.
 * The old cache held only about 70 % of the hours (whole stretches were absent), which thinned every backtest that reads hourly IV.
 *   node dvol_refetch.mjs         writes a backup (.bak) first, then the full file
 */
import fs from 'node:fs';

const HOUR = 3600_000, DAY = 86400_000, START = Date.UTC(2021, 2, 24), END = Date.now();
const OUT = new URL('./btc-dvol-5y-1h.json', import.meta.url);
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
if (old.length) fs.writeFileSync(new URL('./btc-dvol-5y-1h.bak.json', import.meta.url), JSON.stringify(old));

const m = new Map();
for (let a = START; a < END; a += 14 * DAY) {
  const b = Math.min(a + 14 * DAY, END);
  for (let tr = 0; tr < 4; tr++) {
    try {
      const r = await fetch(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${a}&end_timestamp=${b}&resolution=3600`);
      const j = await r.json(); const d = j && j.result && j.result.data || [];
      for (const x of d) if (x[0] >= START && +x[4] > 0) m.set(x[0], +x[4]);
      if (j.result && j.result.continuation) console.log('continuation present at', new Date(a).toISOString().slice(0, 10), '(window truncated)');
      break;
    } catch (e) { await new Promise(r => setTimeout(r, 1500 * (tr + 1))); }
  }
  await new Promise(r => setTimeout(r, 150));
}
const rows = [...m.entries()].sort((x, y) => x[0] - y[0]);
const have = rows.length, want = Math.floor((rows[rows.length - 1][0] - rows[0][0]) / HOUR) + 1;
console.log('hours fetched', have, 'of', want, '(' + (have / want * 100).toFixed(1) + '%) old file had', old.length);
fs.writeFileSync(OUT, JSON.stringify(rows));
