/**
 * FIVE-YEAR IV-BAND BACKTEST (real prices + real implied-vol index).
 *   IV level  = Deribit DVOL (BTC 30-day implied-vol index, ~5yr history) — REAL implied vol.
 *   Legs      = 0.15Δ call+put, Black–Scholes repriced (r=0), N2N ~3-day expiry proxy.
 *   Stop test = per-leg mark ≥ 2× (and 3×) entry premium, checked on the overnight 1h high/low.
 *   Window    = entry 22:30 IST (17:00 UTC) → exit 07:00 IST (01:30 UTC), weekdays only.
 * Honest caveats: DVOL is 30-day (not the exact 3-day N2N) IV, so short-dated IV is slightly
 * understated → strikes a touch tight → stop% mildly conservative. Legs modelled, not real quotes.
 * Run: node scripts/fiveyear_ivband.mjs
 */
import fs from 'node:fs';
const P = (u) => decodeURIComponent(new URL(u, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const HOUR = 3600_000, DAY = 86400_000, YR = 365 * DAY;

// --- Black–Scholes (r=0) + inverse normal (Acklam) ---
function ncdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
function ninv(p) { const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924], b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857], c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878], d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]; const pl = 0.02425, ph = 1 - pl; let q, r; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); } q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
function bs(S, K, T, sig, cp) { if (T <= 0 || sig <= 0) return Math.max(cp === 'c' ? S - K : K - S, 0); const v = sig * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v, d2 = d1 - v; return cp === 'c' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1); }
// Strike for a target |delta|=0.15 (r=0): N(d1)=delta for call; N(d1)=1-delta for put.
function strikeK(S, T, sig, delta, cp) { const v = sig * Math.sqrt(T), d1 = ninv(cp === 'c' ? delta : 1 - delta); return S * Math.exp(0.5 * sig * sig * T - d1 * v); }

async function fetchDvol() {
  const CACHE = P('./btc-dvol-5y.json');
  if (fs.existsSync(CACHE)) { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.length > 1000) return c; }
  const end = Date.now(); let t = 1609459200000; const out = []; // from 2021-01-01
  while (t < end) {
    const to = Math.min(t + 900 * DAY, end);
    const u = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${t}&end_timestamp=${to}&resolution=86400`;
    const r = await fetch(u); const j = await r.json(); const d = j.result && j.result.data || [];
    for (const row of d) out.push([row[0], row[4]]); // [ts, close DVOL]
    if (!d.length) { t = to + DAY; continue; }
    t = d[d.length - 1][0] + DAY; await new Promise((s) => setTimeout(s, 120));
  }
  fs.writeFileSync(CACHE, JSON.stringify(out));
  console.log(`[dvol] ${out.length} days ${new Date(out[0][0]).toISOString().slice(0, 10)} → ${new Date(out[out.length - 1][0]).toISOString().slice(0, 10)}`);
  return out;
}

const dkey = (ts) => new Date(ts).toISOString().slice(0, 10);

async function main() {
  const prices = JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'), 'utf8')); // [[openTime,high,low,close]]
  const byT = new Map(); for (const b of prices) byT.set(b[0], b);
  const dvol = await fetchDvol(); const dv = new Map(); for (const [ts, v] of dvol) dv.set(dkey(ts), v);

  const T0 = 3 / 365; // N2N ~3-day expiry proxy
  const bands = [[0, 25, '<25 thin'], [25, 35, '25–35 calm'], [35, 45, '35–45 mid'], [45, 55, '45–55 rich'], [55, 65, '55–65 hot'], [65, 999, '65+ panic']];
  const agg = bands.map(([lo, hi, lab]) => ({ lo, hi, lab, n: 0, s2: 0, s3: 0 }));

  const first = prices[0][0], last = prices[prices.length - 1][0];
  let total = 0;
  for (let d = Math.ceil(first / DAY) * DAY; d < last; d += DAY) {
    const wd = new Date(d + 17 * HOUR).getUTCDay(); if (wd < 1 || wd > 5) continue; // weekdays only
    const entry = byT.get(d + 17 * HOUR); if (!entry) continue;
    const S0 = entry[3]; const ivPct = dv.get(dkey(d + 17 * HOUR)); if (!(S0 > 0) || ivPct == null) continue;
    const iv = ivPct / 100;
    const Kc = strikeK(S0, T0, iv, 0.15, 'c'), Kp = strikeK(S0, T0, iv, 0.15, 'p');
    const c0 = bs(S0, Kc, T0, iv, 'c'), p0 = bs(S0, Kp, T0, iv, 'p');
    if (!(c0 > 0) || !(p0 > 0)) continue;
    let st2 = false, st3 = false, have = 0;
    for (let h = 0; h <= 8; h++) {
      const b = byT.get(d + 17 * HOUR + h * HOUR); if (!b) continue; have++;
      const T = Math.max(T0 - h * HOUR / YR, 1 / 365 / 24);
      const cHi = bs(b[1], Kc, T, iv, 'c'), pLo = bs(b[2], Kp, T, iv, 'p');
      if (cHi >= 2 * c0 || pLo >= 2 * p0) st2 = true;
      if (cHi >= 3 * c0 || pLo >= 3 * p0) st3 = true;
    }
    if (have < 6) continue;
    const band = agg.find((a) => ivPct >= a.lo && ivPct < a.hi); if (!band) continue;
    band.n++; if (st2) band.s2++; if (st3) band.s3++; total++;
  }

  const pct = (n, d) => (d ? (n / d * 100).toFixed(1) : '—');
  console.log('='.repeat(84));
  console.log(`FIVE-YEAR IV-BAND BACKTEST — ${total} weekday nights, DVOL + BS legs (${new Date(first).toISOString().slice(0, 10)}→${new Date(last).toISOString().slice(0, 10)})`);
  console.log('='.repeat(84));
  console.log('  IV band        n    stop%@2×   stop%@3×   3× helps?');
  for (const a of agg) {
    if (!a.n) continue;
    const gain = a.s2 / a.n - a.s3 / a.n;
    console.log(`  ${a.lab.padEnd(12)} ${String(a.n).padStart(4)}    ${pct(a.s2, a.n).padStart(6)}    ${pct(a.s3, a.n).padStart(6)}    ${(gain * 100).toFixed(1)}pp lower`);
  }
  console.log('\n  Reads: which IV bands are safe vs risky over 5yr, and whether a 3× stop meaningfully helps each.');
  console.log('  (DVOL=30-day IV proxy for the 3-day N2N; legs BS-modelled. Band shape is the signal, not exact %.)');
}
main().catch((e) => { console.error(e); process.exit(1); });
