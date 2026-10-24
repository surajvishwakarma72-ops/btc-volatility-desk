/**
 * Exports the usual N2N IV path from the New York open to 07:00 IST, per weekday, for the IV chart's "IV fall used / room" level.
 * Reads n2n_iv_cache.json (written by n2n_iv_nightpath.mjs). Writes data/n2n_iv_path.js (+ frontend/public/data).
 *
 * Path = cumulative % change of the N2N ATM straddle IV from 19:30 IST (the first hourly sample after the 19:00 NY open) to each
 * later hourly sample (:30 IST) up to 07:30 IST next morning. Per weekday: median, 25th and 75th percentile, and n.
 */
import fs from 'node:fs';

const IVC = JSON.parse(fs.readFileSync(new URL('./n2n_iv_cache.json', import.meta.url), 'utf8'));
const spots = JSON.parse(fs.readFileSync(new URL('./btc-1h-5y.json', import.meta.url), 'utf8'));
const spotAt = new Map(spots.map(r => [r[0], r[3]]));
const H = 3600000, D1 = 86400000;
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
const b76 = (F, K, T, s, call) => { const sd = s * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd, d2 = d1 - sd; return call ? F * N(d1) - K * N(d2) : K * N(-d2) - F * N(-d1); };
const stIv = (C, P, F, K, T) => { const tot = C + P; if (!(tot > 0) || !(T > 0)) return null; let lo = 0.01, hi = 5; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (b76(F, K, T, m, true) + b76(F, K, T, m, false) > tot) ? hi = m : lo = m; } return (lo + hi) / 2 * 100; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const LABELS = []; for (let k = 0; k <= 12; k++) { const h = (19 + k) % 24; LABELS.push(String(h).padStart(2, '0') + ':30'); }
const per = { 1: [], 2: [], 3: [], 4: [], 5: [] };
for (const key of Object.keys(IVC)) {
  const n = IVC[key]; if (!n) continue; const d = n.d, wd = new Date(d).getUTCDay(); if (wd < 1 || wd > 5) continue;
  const at = open => { const r = n.B.find(y => y[0] === open); const F = spotAt.get(open); return r && F ? stIv(r[1], r[2], F, n.K2, (n.e2 - (open + H)) / (365 * D1)) : null; };
  const v = []; for (let k = 0; k <= 12; k++) v.push(at(d + (13 + k) * H)); if (v.some(x => x == null || !isFinite(x))) continue;
  per[wd].push(v.map(x => (x / v[0] - 1) * 100));
}
const out = { generated: new Date().toISOString().slice(0, 10), basis: 'Delta India N2N daily-option ATM straddle IV (mark candles), Mar 2024 - Oct 2026; % change from 19:30 IST', labels: LABELS, byWd: {} };
for (const wd of [1, 2, 3, 4, 5]) {
  const r = per[wd]; if (r.length < 30) continue;
  const col = i => r.map(x => x[i]);
  out.byWd[wd] = { n: r.length, med: LABELS.map((_, i) => +q(col(i), .5).toFixed(2)), p25: LABELS.map((_, i) => +q(col(i), .25).toFixed(2)), p75: LABELS.map((_, i) => +q(col(i), .75).toFixed(2)) };
  console.log(['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'][wd], 'n', r.length, 'median path', out.byWd[wd].med.join(' '));
}
const js = 'window.__N2N_IV_PATH = ' + JSON.stringify(out) + ';\n';
const root = new URL('../../', import.meta.url);
fs.writeFileSync(new URL('data/n2n_iv_path.js', root), js);
fs.mkdirSync(new URL('frontend/public/data/', root), { recursive: true });
fs.writeFileSync(new URL('frontend/public/data/n2n_iv_path.js', root), js);
console.log('written');
