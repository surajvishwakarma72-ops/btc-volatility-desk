/**
 * FIVE-YEAR OVERNIGHT-MOVE STUDY (real Binance prices, no IV modelling — labelled honestly).
 * The thing that stops a short strangle is how far BTC MOVES during the overnight hold. We measure,
 * over 5 years, the max move in the NY hold window (entry 22:30 IST = 17:00 UTC → exit 07:00 IST =
 * 01:30 UTC next day), then aggregate by weekday and month. Bigger move = more likely to breach a
 * short-strangle strike. This is REAL price data; option legs are not modelled (we have 1yr of IV only).
 *
 * Run: node scripts/fiveyear_moves.mjs
 */
import fs from 'node:fs';

const CACHE = decodeURIComponent(new URL('./btc-1h-5y.json', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const HOUR = 3600_000, DAY = 86400_000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function fetchKlines() {
  if (fs.existsSync(CACHE)) { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.length > 40000) { console.log(`[cache] ${c.length} 1h bars`); return c; } }
  const end = Date.now(), start = end - 5 * 365 * DAY;
  const out = [];
  let t = start;
  while (t < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${t}&limit=1000`;
    const r = await fetch(url);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) break;
    for (const k of arr) out.push([k[0], +k[2], +k[3], +k[4]]); // [openTime, high, low, close]
    t = arr[arr.length - 1][0] + HOUR;
    if (arr.length < 1000) break;
    await new Promise((res) => setTimeout(res, 120));
  }
  fs.writeFileSync(CACHE, JSON.stringify(out));
  console.log(`[fetched] ${out.length} 1h bars ${new Date(out[0][0]).toISOString().slice(0, 10)} → ${new Date(out[out.length - 1][0]).toISOString().slice(0, 10)}`);
  return out;
}

const pctile = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

async function main() {
  const bars = await fetchKlines();
  const byT = new Map(); for (const b of bars) byT.set(b[0], b);
  // Entry anchor: 17:00 UTC each day (= 22:30 IST). Window to +8h30 (→ 01:30 UTC next day).
  const nights = [];
  const first = bars[0][0], last = bars[bars.length - 1][0];
  for (let d = Math.ceil(first / DAY) * DAY; d < last; d += DAY) {
    const entryT = d + 17 * HOUR;
    const entry = byT.get(entryT); if (!entry) continue;
    const p0 = entry[3]; if (!(p0 > 0)) continue;
    let hi = p0, lo = p0, have = 0;
    for (let h = 0; h <= 8; h++) { const b = byT.get(entryT + h * HOUR); if (!b) continue; have++; if (b[1] > hi) hi = b[1]; if (b[2] < lo) lo = b[2]; }
    if (have < 6) continue;
    const up = (hi - p0) / p0 * 100, dn = (p0 - lo) / p0 * 100, mv = Math.max(up, dn);
    const wd = new Date(entryT).getUTCDay(), mo = new Date(entryT).getUTCMonth();
    nights.push({ wd, mo, up, dn, mv, dir: up >= dn ? 'up' : 'dn' });
  }

  console.log('='.repeat(92));
  console.log(`FIVE-YEAR OVERNIGHT MOVES — ${nights.length} nights, NY hold 22:30→07:00 IST (real BTC prices)`);
  console.log('='.repeat(92));

  const danger3 = (r) => r.filter((x) => x.mv > 3).length, danger4 = (r) => r.filter((x) => x.mv > 4).length;
  console.log('\nBY WEEKDAY (entry night):');
  console.log('  day   n    medMove%  p90Move%  >3%   >4%   up-breaks  dn-breaks');
  for (const w of [1, 2, 3, 4, 5, 6, 0]) {
    const r = nights.filter((x) => x.wd === w); if (!r.length) continue;
    const up = r.filter((x) => x.dir === 'up' && x.mv > 3).length, dn = r.filter((x) => x.dir === 'dn' && x.mv > 3).length;
    console.log(`  ${DOW[w]}  ${String(r.length).padStart(3)}   ${pctile(r.map((x) => x.mv), 0.5).toFixed(2).padStart(6)}   ${pctile(r.map((x) => x.mv), 0.9).toFixed(2).padStart(6)}  ${(danger3(r) / r.length * 100).toFixed(0).padStart(3)}%  ${(danger4(r) / r.length * 100).toFixed(0).padStart(3)}%   ${String(up).padStart(6)}     ${String(dn).padStart(6)}`);
  }

  console.log('\nBY MONTH:');
  console.log('  mon   n    medMove%  p90Move%  >3%   >4%');
  for (let m = 0; m < 12; m++) {
    const r = nights.filter((x) => x.mo === m); if (!r.length) continue;
    console.log(`  ${MON[m]}  ${String(r.length).padStart(3)}   ${pctile(r.map((x) => x.mv), 0.5).toFixed(2).padStart(6)}   ${pctile(r.map((x) => x.mv), 0.9).toFixed(2).padStart(6)}  ${(danger3(r) / r.length * 100).toFixed(0).padStart(3)}%  ${(danger4(r) / r.length * 100).toFixed(0).padStart(3)}%`);
  }

  const wk = nights.filter((x) => x.wd >= 1 && x.wd <= 5), we = nights.filter((x) => x.wd === 0 || x.wd === 6);
  console.log(`\n  Weekday avg move ${mean(wk.map((x) => x.mv)).toFixed(2)}% vs weekend ${mean(we.map((x) => x.mv)).toFixed(2)}% (external research: ~2.66 vs 1.91).`);
  console.log('  >3% move ≈ the zone a 0.15Δ overnight strangle starts getting stopped. Lower = safer night/month.');

  // Emit the 5-year risk map for the calendar/clock (real prices; labelled honestly in the UI).
  const wdRisk = {}, moRisk = {};
  for (const w of [1, 2, 3, 4, 5, 0]) {
    const r = nights.filter((x) => x.wd === w); if (!r.length) continue;
    wdRisk[DOW[w]] = { n: r.length, med: +pctile(r.map((x) => x.mv), 0.5).toFixed(2), p90: +pctile(r.map((x) => x.mv), 0.9).toFixed(2), danger3: +(danger3(r) / r.length * 100).toFixed(0), danger4: +(danger4(r) / r.length * 100).toFixed(0) };
  }
  for (let m = 0; m < 12; m++) {
    const r = nights.filter((x) => x.mo === m); if (!r.length) continue;
    moRisk[MON[m]] = { n: r.length, med: +pctile(r.map((x) => x.mv), 0.5).toFixed(2), p90: +pctile(r.map((x) => x.mv), 0.9).toFixed(2), danger3: +(danger3(r) / r.length * 100).toFixed(0), danger4: +(danger4(r) / r.length * 100).toFixed(0) };
  }
  const payload = { span: `${new Date(first).toISOString().slice(0, 10)}..${new Date(last).toISOString().slice(0, 10)}`, nights: nights.length, basis: 'real Binance 1h prices, overnight NY-hold move; option legs NOT modelled (1yr IV only)', weekday: wdRisk, month: moRisk };
  const fe = decodeURIComponent(new URL('../../frontend/public/data/fiveyear_risk.js', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
  fs.writeFileSync(fe, `window.__STRANGLE_FIVEYEAR = ${JSON.stringify(payload)};\n`);
  console.log(`\n[fiveyear] wrote frontend/public/data/fiveyear_risk.js (window.__STRANGLE_FIVEYEAR).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
