/**
 * FIVE-YEAR SPEED vs IV BACKTEST (real prices + real implied-vol index).
 *   Speed = realised vol (24h, annualised from 1h returns) ÷ IV (DVOL). >1 = price moving FASTER
 *           than IV prices in (the desk's "Speed Beacon"; ≥1.5 = storm). <1 = calm.
 *   Does entering only when speed is calm actually cut the overnight strangle's stop rate — and
 *   does it matter more in some IV bands? Legs BS-modelled (0.15Δ, N2N 3-day), stop @2×.
 * Honest caveats: DVOL=30-day IV proxy; RV24 from 1h bars (not 1m); legs modelled, not quoted.
 * Run: node scripts/fiveyear_speed.mjs
 */
import fs from 'node:fs';
const P = (u) => decodeURIComponent(new URL(u, import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const HOUR = 3600_000, DAY = 86400_000, YR = 365 * DAY;
function ncdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
function ninv(p) { const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924], b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857], c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878], d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742]; const pl = 0.02425, ph = 1 - pl; let q, r; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); } q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
function bs(S, K, T, sig, cp) { if (T <= 0 || sig <= 0) return Math.max(cp === 'c' ? S - K : K - S, 0); const v = sig * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v, d2 = d1 - v; return cp === 'c' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1); }
function strikeK(S, T, sig, delta, cp) { const v = sig * Math.sqrt(T), d1 = ninv(cp === 'c' ? delta : 1 - delta); return S * Math.exp(0.5 * sig * sig * T - d1 * v); }
const dkey = (ts) => new Date(ts).toISOString().slice(0, 10);

function main() {
  const prices = JSON.parse(fs.readFileSync(P('./btc-1h-5y.json'), 'utf8')); // [[openTime,high,low,close]]
  const byT = new Map(); for (const b of prices) byT.set(b[0], b);
  const dvol = JSON.parse(fs.readFileSync(P('./btc-dvol-5y.json'), 'utf8')); const dv = new Map(); for (const [ts, v] of dvol) dv.set(dkey(ts), v);
  const T0 = 3 / 365;
  const ANN = Math.sqrt(24 * 365);

  const spB = [[0, 1.0, 'calm <1.0'], [1.0, 1.5, 'normal 1.0–1.5'], [1.5, 2.0, 'fast 1.5–2.0'], [2.0, 99, 'storm ≥2.0']];
  const ivB = [[0, 35, '<35'], [35, 45, '35–45'], [45, 55, '45–55'], [55, 99, '55+']];
  const sp = spB.map(([lo, hi, lab]) => ({ lo, hi, lab, n: 0, s: 0 }));
  const grid = {}; for (const [, , sl] of spB) { grid[sl] = {}; for (const [, , il] of ivB) grid[sl][il] = { n: 0, s: 0 }; }

  const first = prices[0][0], last = prices[prices.length - 1][0];
  let total = 0;
  for (let d = Math.ceil(first / DAY) * DAY; d < last; d += DAY) {
    const E = d + 17 * HOUR; const wd = new Date(E).getUTCDay(); if (wd < 1 || wd > 5) continue;
    const entry = byT.get(E); const ivPct = dv.get(dkey(E)); if (!entry || ivPct == null || !(entry[3] > 0)) continue;
    // RV24 = annualised std of last 24 1h log-returns
    const rets = [];
    for (let h = 24; h >= 1; h--) { const a = byT.get(E - h * HOUR), b = byT.get(E - (h - 1) * HOUR); if (a && b && a[3] > 0 && b[3] > 0) rets.push(Math.log(b[3] / a[3])); }
    if (rets.length < 18) continue;
    const m = rets.reduce((x, y) => x + y, 0) / rets.length;
    const rv = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1)) * ANN * 100;
    const speed = rv / ivPct;
    const S0 = entry[3], iv = ivPct / 100;
    const Kc = strikeK(S0, T0, iv, 0.15, 'c'), Kp = strikeK(S0, T0, iv, 0.15, 'p');
    const c0 = bs(S0, Kc, T0, iv, 'c'), p0 = bs(S0, Kp, T0, iv, 'p'); if (!(c0 > 0) || !(p0 > 0)) continue;
    let stop = false, have = 0;
    for (let h = 0; h <= 8; h++) { const b = byT.get(E + h * HOUR); if (!b) continue; have++; const T = Math.max(T0 - h * HOUR / YR, 1 / 365 / 24); if (bs(b[1], Kc, T, iv, 'c') >= 2 * c0 || bs(b[2], Kp, T, iv, 'p') >= 2 * p0) stop = true; }
    if (have < 6) continue;
    const sb = sp.find((x) => speed >= x.lo && speed < x.hi); const ib = ivB.find((x) => ivPct >= x[0] && ivPct < x[1]);
    if (!sb || !ib) continue;
    sb.n++; if (stop) sb.s++; const g = grid[sb.lab][ib[2]]; g.n++; if (stop) g.s++; total++;
  }

  const pct = (n, d) => (d ? (n / d * 100).toFixed(1) : '—');
  console.log('='.repeat(84));
  console.log(`FIVE-YEAR SPEED vs IV — ${total} weekday nights, stop@2× (${new Date(first).toISOString().slice(0, 10)}→${new Date(last).toISOString().slice(0, 10)})`);
  console.log('='.repeat(84));
  console.log('\n1) BY SPEED (realised÷implied at entry):');
  console.log('  speed bucket       n    stop%');
  for (const x of sp) if (x.n) console.log(`  ${x.lab.padEnd(16)} ${String(x.n).padStart(4)}   ${pct(x.s, x.n).padStart(5)}`);
  console.log('\n2) SPEED × IV grid (stop% / n):');
  console.log('  speed \\ IV       <35        35–45       45–55       55+');
  for (const [, , sl] of spB) {
    const cells = ivB.map(([, , il]) => { const g = grid[sl][il]; return (g.n ? `${pct(g.s, g.n)}% (${g.n})` : '—').padStart(11); });
    console.log('  ' + sl.padEnd(14) + cells.join(' '));
  }
  console.log('\n  Reads: does calm speed cut stops, and does it matter more at high IV?');
}
main();
