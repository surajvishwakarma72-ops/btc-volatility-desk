/**
 * Impulse study: does the desk's impulse meter (BTC speed over 5 minutes against normal for this time of day, rebuilt here from
 * Binance 1-minute candles with the same Garman-Klass maths) warn BEFORE a big BTC move, and how early?
 * Also tests a plain "string of big candles" rule on 5-minute bars.   node impulse_study.mjs [days=90]
 * Writes nothing; prints the replay of 18 Oct 2026 02:30-03:30 IST and the precision / lead-time tables.
 */
const DAYS = Number(process.argv[2]) || 90, MIN = 60000, IST = 19800000;
const END = Date.now();
async function klines(start, end) {
  const out = [];
  for (let t = start; t < end;) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${t}&limit=1000`);
    if (!r.ok) { await new Promise(x => setTimeout(x, 1500)); continue; }
    const j = await r.json(); if (!j.length) break;
    for (const k of j) out.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    t = +j[j.length - 1][0] + MIN; await new Promise(x => setTimeout(x, 120));
  }
  return out;
}
const ln = Math.log;
function gk(b, pc) { const hl = ln(Math.max(b.h, b.o, b.c) / Math.min(b.l, b.o, b.c)), co = ln(b.c / b.o); let v = 0.5 * hl * hl - 0.3863 * co * co; if (pc > 0) { const g = ln(b.o / pc); v += g * g; } return v > 0 ? v : 0; }
const weekend = t => { const w = (Math.floor(t / 86400000) + 4) % 7, h = Math.floor(t % 86400000 / 3600000); return (w === 5 && h >= 21) || w === 6 || (w === 0 && h < 22); };
const NB = 96, slot = t => Math.floor((((t + IST) % 86400000) + 86400000) % 86400000 / (15 * MIN)), keyOf = t => (weekend(t) ? NB : 0) + slot(t);
const quant = (s, q) => { const p = (s.length - 1) * q, i = Math.floor(p), f = p - i; return i + 1 < s.length ? s[i] * (1 - f) + s[i + 1] * f : s[i]; };
const median = a => quant(a.slice().sort((x, y) => x - y), 0.5);

console.log('downloading', DAYS, 'days of 1m candles ...');
const bars = await klines(END - DAYS * 86400000, END); const n = bars.length; console.log('bars', n);
const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = gk(bars[i], i && bars[i].t - bars[i - 1].t === MIN ? bars[i - 1].c : 0);
const v5 = new Float64Array(n).fill(NaN); for (let i = 4; i < n; i++) v5[i] = (v[i] + v[i - 1] + v[i - 2] + v[i - 3] + v[i - 4]) / 5;
const bins = Array.from({ length: 2 * NB }, () => []), all = [];
for (let i = 4; i < n; i++) { bins[keyOf(bars[i].t)].push(v5[i]); all.push(v5[i]); }
all.sort((a, b) => a - b); const medAll = quant(all, 0.5), base = new Float64Array(2 * NB);
for (let c = 0; c < 2; c++) for (let s = 0; s < NB; s++) { const a = [s - 1, s, s + 1].flatMap(x => bins[c * NB + ((x + NB) % NB)]); const b = a.length >= 30 ? median(a) : medAll; base[c * NB + s] = Math.max(b > 0 ? b : medAll, medAll * 0.05); }
const r = new Float64Array(n).fill(NaN), pool = []; for (let i = 4; i < n; i++) { r[i] = Math.sqrt(v5[i] / base[keyOf(bars[i].t)]); pool.push(r[i]); }
pool.sort((a, b) => a - b); const T = [Math.min(1.2, Math.max(0.8, quant(pool, 0.5))), 0, 0]; T[1] = Math.max(quant(pool, 0.9), 1.5); T[2] = Math.max(quant(pool, 0.99), 2.5, T[1] + 0.5);
console.log('thresholds calm/fast/impulse', T.map(x => x.toFixed(2)).join(' / '));
const st = i => r[i] < T[0] ? 0 : r[i] < T[1] ? 1 : r[i] < T[2] ? 2 : 3;
const ist = t => new Date(t + IST).toISOString().slice(5, 16).replace('T', ' ');

/* ---- replay of 18 Oct 2026 02:30 - 03:30 IST ---- */
const R0 = Date.UTC(2026, 9, 17, 21, 0), R1 = Date.UTC(2026, 9, 17, 22, 0);
console.log('\nREPLAY 18 Oct 2026 (IST): minute, price, impulse ratio, state');
for (let i = 0; i < n; i++) if (bars[i].t >= R0 && bars[i].t <= R1 && (bars[i].t / MIN) % 3 === 0) console.log(' ', ist(bars[i].t), bars[i].c.toFixed(0).padStart(6), 'r', (r[i] || 0).toFixed(2).padStart(5), ['calm', 'normal', 'FAST', 'IMPULSE'][st(i)]);

console.log('\nMINUTE BY MINUTE 02:48-02:58 IST: price, 5-min speed ratio');
for (let i = 0; i < n; i++) if (bars[i].t >= Date.UTC(2026, 9, 17, 21, 18) && bars[i].t <= Date.UTC(2026, 9, 17, 21, 28)) console.log(' ', ist(bars[i].t), bars[i].c.toFixed(0).padStart(6), 'r', (r[i] || 0).toFixed(2).padStart(5), r[i] >= 1.5 ? '<-- >= 1.5' : '');
/* ---- big-move label: the next 60 minutes span >= 0.7 % high to low ---- */
const BIG = 0.007, H = 60, big = new Uint8Array(n);
for (let i = 0; i < n - H; i++) { let hi = -1, lo = 1e12; for (let k = 1; k <= H; k++) { const b = bars[i + k]; if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; } big[i] = (hi - lo) / bars[i].c >= BIG ? 1 : 0; }
const idx = []; for (let i = 300; i < n - H; i++) idx.push(i);
const rate = a => a.length ? a.filter(i => big[i]).length / a.length * 100 : NaN, baseRate = rate(idx);
console.log('\nBIG MOVE = the next 60 min span >= ' + BIG * 100 + '% of price. Base rate ' + baseRate.toFixed(1) + '% of minutes.');
const row = (nm, a) => console.log('  ' + nm.padEnd(60) + ' n ' + String(a.length).padStart(6) + '  big move follows ' + rate(a).toFixed(1).padStart(5) + '%   x' + (rate(a) / baseRate).toFixed(1));

/* 5-minute candles built from the 1m bars */
const c5 = []; for (let i = 0; i + 4 < n; i++) if ((bars[i].t / MIN) % 5 === 0) { let h = -1, l = 1e12; for (let k = 0; k < 5; k++) { h = Math.max(h, bars[i + k].h); l = Math.min(l, bars[i + k].l); } c5.push({ t: bars[i].t, o: bars[i].o, c: bars[i + 4].c, h, l, i: i + 4 }); }
const med5 = []; for (let j = 0; j < c5.length; j++) { const w = c5.slice(Math.max(0, j - 24), j).map(x => x.h - x.l); med5.push(w.length >= 12 ? median(w) : null); }
const string = new Map(); // minute index at the close of a 5m candle that completes a string
for (let j = 2; j < c5.length; j++) { const m = med5[j]; if (!m) continue;
  const a = c5[j - 1], b = c5[j], da = Math.sign(a.c - a.o), db = Math.sign(b.c - b.o);
  const bigA = (a.h - a.l) >= 2 * m, bigB = (b.h - b.l) >= 2 * m;
  const one = bigB && (b.h - b.l) >= 3 * m, two = bigA && bigB && da === db && da !== 0;
  if (one || two) string.set(b.i, { one, two });
}
const trig = f => idx.filter(f);
row('impulse meter: FAST or IMPULSE (r >= 1.5)', trig(i => st(i) >= 2));
row('speed ratio r >= 1.5 (watch level)', trig(i => r[i] >= 1.5));
row('speed ratio r >= 2.0', trig(i => r[i] >= 2.0));
row('impulse meter: IMPULSE (r >= 2.5)', trig(i => st(i) >= 3));
row('impulse meter: r >= 2 and one-way (net/path over 15 m >= 0.5)', trig(i => { if (!(r[i] >= 2)) return false; let path = 0; for (let k = i - 14; k <= i; k++) path += Math.abs(bars[k].c - bars[k - 1].c); const net = Math.abs(bars[i].c - bars[i - 14].c); return path > 0 && net / path >= 0.5; }));
row('one 5m candle >= 3x its 2-hour median range', trig(i => string.has(i) && string.get(i).one));
row('string: two 5m candles in a row, same way, each >= 2x median', trig(i => string.has(i) && string.get(i).two));
row('none of the above (quiet)', trig(i => st(i) <= 1 && !string.has(i)));

/* ---- lead time: for each big-move episode, when did the first warning fire relative to the largest 5-minute candle? ---- */
let eps = 0, warned = 0; const leads = [];
for (let j = 30; j < c5.length - 14; j++) { const rng = c5[j].h - c5[j].l, m = med5[j]; if (!m || rng < 5 * m || rng / c5[j].c < 0.0035) continue; // a candle >= 5x normal and >= 0.35 %
  // skip if a bigger candle sits within the previous hour (same episode)
  let first = false; if (c5.slice(Math.max(0, j - 12), j).some(x => (x.h - x.l) >= rng)) continue; eps++;
  let lead = null; for (let k = c5[j].i - 30; k < c5[j].i - 4; k++) { if (st(k) >= 2 || (string.has(k))) { lead = (c5[j].i - 4 - k); break; } }
  if (lead != null) { warned++; leads.push(lead); } }
leads.sort((a, b) => a - b);
console.log('\nBIG-CANDLE EPISODES (a 5m candle >= 5x normal and >= 0.35 % of price): ' + eps + '; a warning (fast/impulse reading or a string) fired in the 30 minutes before it in ' + warned + ' (' + (warned / eps * 100).toFixed(0) + '%), median lead ' + (leads.length ? leads[leads.length >> 1] : '-') + ' min');

/* ---- write the numbers for the desk ---- */
import fs from 'node:fs';
const rowsOut = [];
const add = (name, a) => rowsOut.push({ name, n: a.length, pct: +rate(a).toFixed(1), lift: +(rate(a) / baseRate).toFixed(2) });
add('speed ratio 1.5× normal or more', trig(i => r[i] >= 1.5));
add('impulse meter FAST (top 10 %, 1.5× or more)', trig(i => st(i) >= 2));
add('impulse meter IMPULSE (top 1 %, 2.5× or more)', trig(i => st(i) >= 3));
add('two 5-minute candles in a row, same way, each 2× the usual range', trig(i => string.has(i) && string.get(i).two));
add('one 5-minute candle 3× the usual range', trig(i => string.has(i) && string.get(i).one));
add('none of these (quiet)', trig(i => st(i) <= 1 && !string.has(i)));
const rep = []; for (let i = 0; i < n; i++) if (bars[i].t >= Date.UTC(2026, 9, 17, 21, 18) && bars[i].t <= Date.UTC(2026, 9, 17, 21, 28)) rep.push({ ist: ist(bars[i].t).slice(6), price: Math.round(bars[i].c), r: +(r[i] || 0).toFixed(2) });
const out = { generated: new Date().toISOString().slice(0, 10), days: DAYS, bigMove: '60-minute high-low span of 0.7 % of price or more', baseRate: +baseRate.toFixed(1), thresholds: T.map(x => +x.toFixed(2)), rows: rowsOut, episodes: { n: eps, warned, medianLead: leads.length ? leads[leads.length >> 1] : null }, replay: rep };
const js = `window.__STRANGLE_IMPULSE = ${JSON.stringify(out)};\n`;
for (const rel of ['../../data/impulse_study.js', '../../frontend/public/data/impulse_study.js']) fs.writeFileSync(new URL(rel, import.meta.url), js);
console.log('wrote impulse_study.js', JSON.stringify(out).length, 'bytes');
