/**
 * N2N ATM IV by weekday, rebuilt from Delta India MARK-price candles of the EXPIRED daily options (history exists from ~Mar 2024).
 *
 *   node n2n_iv_nightpath.mjs            # fetch (cached in n2n_iv_cache.json) + analyse
 *   NOFETCH=1 node n2n_iv_nightpath.mjs  # analyse the cache only
 *
 * For every weekday D (IST date) the desk's N2N at the 22:30 IST entry is the daily expiry D+3 (12:00 UTC = 17:30 IST); during the
 * morning and afternoon the N2N was the expiry D+2, and it rolls to D+3 at 17:30 IST. IV is the ATM straddle IV (call + put marks at the
 * strike nearest spot, rounded to 1000, Black-76 with r = 0, forward = Binance 1h close) so there is no skew or strike-drift noise.
 * Segments, each on ONE fixed expiry:
 *   A  07:30 -> 16:30 IST   expiry D+2   (the day, before the 17:30 roll)
 *   B  18:30 -> 22:30 IST   expiry D+3   (evening after the roll, before entry)
 *   C  22:30 -> 07:30 IST   expiry D+3   (the night you are short)
 * The sample hours sit on :30 IST because the hourly candles close on the UTC hour.
 */
import fs from 'node:fs';

const B = 'https://api.india.delta.exchange';
const CACHE = new URL('./n2n_iv_cache.json', import.meta.url);
const spots = JSON.parse(fs.readFileSync(new URL('./btc-1h-5y.json', import.meta.url), 'utf8'));   // [openMs, high, low, close]
const spotAt = new Map(spots.map(r => [r[0], r[3]]));                                             // close of the hour that OPENS at r[0]
const H = 3600000, D1 = 86400000;
const ds = ms => { const d = new Date(ms); return String(d.getUTCDate()).padStart(2, '0') + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCFullYear() % 100); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
const b76 = (F, K, T, s, call) => { const sd = s * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd, d2 = d1 - sd; return call ? F * N(d1) - K * N(d2) : K * N(-d2) - F * N(-d1); };
function straddleIv(C, P, F, K, T) { const tot = C + P; if (!(tot > 0) || !(T > 0)) return null; let lo = 0.01, hi = 5; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (b76(F, K, T, m, true) + b76(F, K, T, m, false) > tot) ? hi = m : lo = m; } return (lo + hi) / 2 * 100; }

async function candles(sym, a, b) {
  const u = `${B}/v2/history/candles?resolution=1h&symbol=${encodeURIComponent(sym)}&start=${Math.floor(a / 1000)}&end=${Math.floor(b / 1000)}`;
  for (let k = 0; k < 6; k++) {
    try { const r = await fetch(u); if (r.status === 429) { await sleep(800 * (k + 1)); continue; } const j = await r.json(); return (j.result || []).map(c => [c.time * 1000, +c.close]); }
    catch (e) { await sleep(500 * (k + 1)); }
  }
  return null;
}
async function legs(expMs, K, a, b) {
  const e = ds(expMs); const [c, p] = await Promise.all([candles(`MARK:C-BTC-${K}-${e}`, a, b), candles(`MARK:P-BTC-${K}-${e}`, a, b)]);
  if (!c || !p) return null; const pm = new Map(p); return c.filter(x => pm.has(x[0])).map(x => [x[0], x[1], pm.get(x[0])]);
}
const roundK = S => Math.round(S / 1000) * 1000;

async function fetchNight(dayMs) {   // dayMs = 00:00 UTC of the IST date D
  const sA = spotAt.get(dayMs + 1 * H), sB = spotAt.get(dayMs + 12 * H); if (!sA || !sB) return null;
  const e1 = dayMs + 2 * D1 + 12 * H, e2 = dayMs + 3 * D1 + 12 * H;
  const A = await legs(e1, roundK(sA), dayMs + 1 * H, dayMs + 11 * H + 1);
  const Bc = await legs(e2, roundK(sB), dayMs + 12 * H, dayMs + D1 + 1 * H + 1);
  if (!A || !Bc) return null; return { d: dayMs, e1, e2, K1: roundK(sA), K2: roundK(sB), A, B: Bc };
}

let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { }
if (!process.env.NOFETCH) {
  const start = Date.UTC(2024, 2, 18), end = Date.now() - 4 * D1; const todo = [];
  for (let d = start; d < end; d += D1) { const wd = new Date(d).getUTCDay(); if (wd >= 1 && wd <= 5 && !(d in cache)) todo.push(d); }
  console.log('to fetch', todo.length); let done = 0;
  const worker = async () => { while (todo.length) { const d = todo.shift(); try { const r = await fetchNight(d); cache[d] = r; } catch (e) { cache[d] = null; } if (++done % 40 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log('  ', done); } } };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  fs.writeFileSync(CACHE, JSON.stringify(cache));
}

// ---- analysis ----
const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const rows = [];
for (const k of Object.keys(cache)) {
  const n = cache[k]; if (!n) continue; const d = n.d;
  const ivA = (candleOpen, arr, K, exp) => { const r = arr.find(x => x[0] === candleOpen); if (!r) return null; const t = candleOpen + H, F = spotAt.get(candleOpen); if (!F) return null; return straddleIv(r[1], r[2], F, K, (exp - t) / (365 * D1)); };
  const a0 = ivA(d + 1 * H, n.A, n.K1, n.e1), a1 = ivA(d + 10 * H, n.A, n.K1, n.e1);                       // 07:30 and 16:30 IST
  const b0 = ivA(d + 12 * H, n.B, n.K2, n.e2), b1 = ivA(d + 15 * H, n.B, n.K2, n.e2), b2 = ivA(d + 16 * H, n.B, n.K2, n.e2);   // 18:30, 21:30, 22:30 IST
  const c1 = ivA(d + D1 + 1 * H, n.B, n.K2, n.e2);                                                         // 07:30 IST next day
  if ([a0, a1, b0, b1, b2, c1].some(v => v == null || !isFinite(v))) continue;
  const path = []; for (let h = 12; h <= D1 / H + 1; h++) { const v = ivA(d + h * H, n.B, n.K2, n.e2); if (v != null) path.push(v); }
  rows.push({ d, wd: new Date(d).getUTCDay(), a0, a1, b0, b1, b2, c1, A: (a1 / a0 - 1) * 100, Bs: (b2 / b0 - 1) * 100, C: (c1 / b2 - 1) * 100, last: (b2 / b1 - 1) * 100, hi: Math.max(...path) / b2 * 100 - 100, lo: Math.min(...path) / b2 * 100 - 100 });
}
const avg = x => x.reduce((p, c) => p + c, 0) / x.length, med = x => { const y = [...x].sort((p, q) => p - q); return y[Math.floor(y.length / 2)]; };
const sd = x => { const m = avg(x); return Math.sqrt(avg(x.map(v => (v - m) ** 2))); };
const corr = (x, y) => { const mx = avg(x), my = avg(y); return avg(x.map((v, i) => (v - mx) * (y[i] - my))) / (sd(x) * sd(y)); };
const f = (v, d = 1) => (v >= 0 ? '+' : '') + v.toFixed(d);
const first = new Date(Math.min(...rows.map(r => r.d))).toISOString().slice(0, 10), lastD = new Date(Math.max(...rows.map(r => r.d))).toISOString().slice(0, 10);
console.log(`nights with full N2N data: ${rows.length}  (${first} .. ${lastD})`);
console.log('\nN2N straddle IV, % change (average / median)  |  level at 22:30  |  P(IV higher at 07:30 than at 22:30)');
console.log('day | n  | A 07:30>16:30 (expiry D+2) | B 18:30>22:30 | C 22:30>07:30 | IV@22:30 | P(C>0) | P(C>+3%) | P(C<-3%) | sd C | night high / low vs 22:30');
const out = {};
for (let w = 1; w <= 5; w++) {
  const r = rows.filter(x => x.wd === w); if (!r.length) continue;
  out[names[w]] = { n: r.length, A: avg(r.map(x => x.A)), Amed: med(r.map(x => x.A)), B: avg(r.map(x => x.Bs)), Bmed: med(r.map(x => x.Bs)), C: avg(r.map(x => x.C)), Cmed: med(r.map(x => x.C)), iv22: avg(r.map(x => x.b2)), pUp: r.filter(x => x.C > 0).length / r.length * 100, pUp3: r.filter(x => x.C > 3).length / r.length * 100, pDn3: r.filter(x => x.C < -3).length / r.length * 100, sdC: sd(r.map(x => x.C)), hi: avg(r.map(x => x.hi)), lo: avg(r.map(x => x.lo)) };
  const o = out[names[w]];
  console.log(names[w], '|', String(o.n).padStart(3), '|', (f(o.A) + ' / ' + f(o.Amed)).padEnd(16), '|', (f(o.B) + ' / ' + f(o.Bmed)).padEnd(14), '|', (f(o.C) + ' / ' + f(o.Cmed)).padEnd(14), '|', o.iv22.toFixed(1).padStart(5), '|', o.pUp.toFixed(0) + '%', '|', o.pUp3.toFixed(0) + '%', '|', o.pDn3.toFixed(0) + '%', '|', o.sdC.toFixed(1), '|', f(o.hi) + ' / ' + f(o.lo));
}
const all = rows; console.log('ALL |', all.length, '| A', f(avg(all.map(x => x.A))), '| B', f(avg(all.map(x => x.Bs))), '| C', f(avg(all.map(x => x.C))), '| P(C>0)', (all.filter(x => x.C > 0).length / all.length * 100).toFixed(0) + '%', '| corr(A+B , C) =', corr(all.map(x => x.A + x.Bs), all.map(x => x.C)).toFixed(3), '| corr(B, C) =', corr(all.map(x => x.Bs), all.map(x => x.C)).toFixed(3), '| corr(last hour, C) =', corr(all.map(x => x.last), all.map(x => x.C)).toFixed(3));

console.log('\nWhat IV did BEFORE 22:30 (A+B, relative to that weekday\'s median) -> what it did AFTER (C):');
const dev = []; for (let w = 1; w <= 5; w++) { const r = rows.filter(x => x.wd === w); if (!r.length) continue; const m = med(r.map(x => x.A + x.Bs)); for (const x of r) dev.push({ d: x.A + x.Bs - m, C: x.C, wd: w }); }
const q = [...dev].sort((a, b) => a.d - b.d); const cut = [q[Math.floor(q.length * .2)].d, q[Math.floor(q.length * .4)].d, q[Math.floor(q.length * .6)].d, q[Math.floor(q.length * .8)].d];
const bk = [['fell MOST vs usual (bottom 20%)', x => x.d <= cut[0]], ['fell more than usual', x => x.d > cut[0] && x.d <= cut[1]], ['about usual', x => x.d > cut[1] && x.d <= cut[2]], ['fell less / rose', x => x.d > cut[2] && x.d <= cut[3]], ['ROSE most vs usual (top 20%)', x => x.d > cut[3]]];
for (const [n, fn] of bk) { const r = dev.filter(fn); console.log(n.padEnd(34), 'n', String(r.length).padStart(4), '| avg C', f(avg(r.map(x => x.C))).padStart(6) + '%', '| P(rise)', (r.filter(x => x.C > 0).length / r.length * 100).toFixed(0) + '%', '| P(rise>3%)', (r.filter(x => x.C > 3).length / r.length * 100).toFixed(0) + '%', '| P(fall>3%)', (r.filter(x => x.C < -3).length / r.length * 100).toFixed(0) + '%'); }
console.log('\nLast hour before entry (21:30 -> 22:30) -> C:');
for (const [n, fn] of [['IV falling >2% in that hour', x => x.last < -2], ['flat (-2..+2)', x => x.last >= -2 && x.last <= 2], ['IV rising >2% in that hour', x => x.last > 2]]) { const r = rows.filter(fn); if (r.length) console.log(n.padEnd(34), 'n', String(r.length).padStart(4), '| avg C', f(avg(r.map(x => x.C))).padStart(6) + '%', '| P(rise)', (r.filter(x => x.C > 0).length / r.length * 100).toFixed(0) + '%', '| P(rise>3%)', (r.filter(x => x.C > 3).length / r.length * 100).toFixed(0) + '%'); }
fs.writeFileSync(new URL('./n2n_iv_summary.json', import.meta.url), JSON.stringify({ n: rows.length, first, last: lastD, byWd: out }, null, 1));
