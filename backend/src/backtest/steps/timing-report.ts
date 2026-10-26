/** Reads the tensors written by backtest-timing.ts and prints the tables. npx tsx src/backtest/steps/timing-report.ts */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTensor, type Tensor } from './backtest-timing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../output');
const T = (sp: number) => loadTensor(path.join(OUT, `timing${process.env.TAG ?? ''}_${sp}.bin`));
const t2 = T(2), t0 = T(0), t4 = T(4);
const NE = t2.expiries.length, ND = t2.deltas.length, NH = t2.holds.length;
const split = Math.floor(NE * 0.6);
const hhmm = (sec: number) => { const m = Math.floor((((sec + 19800) % 86400) + 86400) % 86400 / 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const slotSec = (t: Tensor, s: number, e = 0) => t.expiries[e]! / 1000 - 3 * 86400 - 3600 + (s + 1) * 900;
const slotName = (s: number) => hhmm(slotSec(t2, s));
const slotMin = (s: number) => { const [h, m] = slotName(s).split(':').map(Number); return h! * 60 + m!; };

interface St { n: number; mean: number; win: number; stop: number; tp: number; worst: number; sum: number; sd: number; pf: number }
function stats(t: Tensor, key: number, a = 0, b = NE, filter?: (e: number) => boolean): St {
  const r = t.ret[key]!, w = t.why[key]!;
  let n = 0, sum = 0, ss = 0, win = 0, stop = 0, tp = 0, worst = 0, gp = 0, gl = 0;
  for (let e = a; e < b; e++) {
    const v = r[e]!; if (Number.isNaN(v) || (filter && !filter(e))) continue;
    n++; sum += v; ss += v * v; if (v > 0) { win++; gp += v; } else gl -= v; if (w[e] === 1) stop++; if (w[e] === 2) tp++; if (v < worst) worst = v;
  }
  const mean = n ? sum / n : 0;
  return { n, mean, win: n ? win / n : 0, stop: n ? stop / n : 0, tp: n ? tp / n : 0, worst, sum, sd: n > 1 ? Math.sqrt(Math.max(0, ss / n - mean * mean)) : 0, pf: gl > 0 ? gp / gl : Infinity };
}
const keyOf = (s: number, d: number, h: number) => (s * ND + d) * NH + h;
const label = (k: number) => { const h = k % NH, d = Math.floor(k / NH) % ND, s = Math.floor(k / NH / ND); const hold = t2.holds[h]! * 15; const exit = (slotMin(s) + hold) % 1440; return { s, d, h, entry: slotName(s), exit: String(Math.floor(exit / 60)).padStart(2, '0') + ':' + String(exit % 60).padStart(2, '0'), delta: t2.deltas[d]!, hold: hold / 60 }; };
const pct = (x: number, d = 1) => (x * 100).toFixed(d) + '%';
const row = (k: number, st: St, st2?: St) => { const l = label(k); return `${l.entry} -> ${l.exit} (${l.hold}h)  d${l.delta.toFixed(2)}  n=${String(st.n).padStart(3)}  mean ${pct(st.mean, 2).padStart(7)}  win ${pct(st.win, 0).padStart(4)}  stop ${pct(st.stop, 0).padStart(4)}  tp ${pct(st.tp, 0).padStart(4)}  worst ${pct(st.worst, 0).padStart(5)}  PF ${st.pf === Infinity ? 'inf' : st.pf.toFixed(2)}` + (st2 ? `   | TEST n=${st2.n} mean ${pct(st2.mean, 2)} win ${pct(st2.win, 0)} stop ${pct(st2.stop, 0)} worst ${pct(st2.worst, 0)}` : ''); };

const K = t2.ret.length;
console.log(`Expiries ${NE} (${new Date(t2.expiries[0]!).toISOString().slice(0, 10)} .. ${new Date(t2.expiries[NE - 1]!).toISOString().slice(0, 10)}), train = first ${split}, test = last ${NE - split}. Return = net profit / portfolio margin per trade. TP 10% of margin, stop 2x per leg, exit all.`);

// overall landscape at the 2% spread
let pos = 0, tot = 0, bestAll = 0; const all: Array<{ k: number; tr: St; te: St; fl: St }> = [];
for (let k = 0; k < K; k++) { const tr = stats(t2, k, 0, split), te = stats(t2, k, split, NE), fl = stats(t2, k); if (fl.n < 100) continue; tot++; if (fl.mean > 0) pos++; all.push({ k, tr, te, fl }); bestAll = Math.max(bestAll, fl.mean); }
console.log(`\nLandscape @2% half-spread: ${pos}/${tot} combinations (entry x delta x hold) have a positive mean over the full history (${pct(pos / tot, 1)}). Best full-history mean ${pct(bestAll, 2)}.`);
const meanAll = all.reduce((a, x) => a + x.fl.mean, 0) / all.length;
console.log(`Average over every combination: ${pct(meanAll, 2)} of margin per trade.`);

// selection done on TRAIN, judged on TEST
const byTrain = all.filter((x) => x.tr.n >= 80).sort((a, b) => b.tr.mean - a.tr.mean).slice(0, 15);
console.log('\n=== Top 15 by TRAIN mean (spread 2%), shown with their TEST result ===');
for (const x of byTrain) console.log(row(x.k, x.tr, x.te));
const topTrainTestMean = byTrain.reduce((a, x) => a + x.te.mean, 0) / byTrain.length;
console.log(`Average TEST mean of those 15: ${pct(topTrainTestMean, 2)} (train avg ${pct(byTrain.reduce((a, x) => a + x.tr.mean, 0) / byTrain.length, 2)})`);

const byFull = all.sort((a, b) => b.fl.mean - a.fl.mean).slice(0, 12);
console.log('\n=== Top 12 by FULL-history mean (spread 2%) ===');
for (const x of byFull) console.log(row(x.k, x.fl));

const inWin = (name: string, ranges: Array<[number, number]>) => {
  const ok = (s: number) => { const m = slotMin(s); return ranges.some(([a, b]) => (a <= b ? m >= a && m <= b : m >= a || m <= b)); };
  const c = all.filter((x) => ok(label(x.k).s) && x.fl.n >= 100).sort((a, b) => b.fl.mean - a.fl.mean);
  console.log(`\n=== Your window ${name}: ${c.length} combos, ${c.filter((x) => x.fl.mean > 0).length} positive. Best 8 by full mean; TEST alongside ===`);
  for (const x of c.slice(0, 8)) console.log(row(x.k, x.fl, x.te));
  const avg = c.reduce((a, x) => a + x.fl.mean, 0) / (c.length || 1);
  console.log(`window average over all its combos: ${pct(avg, 2)}`);
};
inWin('22:30-07:00 IST', [[22 * 60 + 30, 7 * 60]]);
inWin('10:00-16:00 IST', [[10 * 60, 16 * 60]]);
inWin('Asia late 04:00-08:00 IST', [[4 * 60, 8 * 60]]);
inWin('New York late 00:30-04:30 IST', [[30, 4 * 60 + 30]]);

// by entry slot (hour buckets), averaged over delta and hold, to see when selling pays at all
console.log('\n=== Mean return by ENTRY hour (IST), all deltas and holds, spread 2% / 0% ===');
for (let hr = 0; hr < 24; hr++) {
  let a = 0, c = 0, a0 = 0, c0 = 0;
  for (let k = 0; k < K; k++) { const s = Math.floor(k / NH / ND); if (Math.floor(slotMin(s) / 60) !== hr) continue; const x = stats(t2, k); if (x.n >= 100) { a += x.mean; c++; } const y = stats(t0, k); if (y.n >= 100) { a0 += y.mean; c0++; } }
  console.log(`${String(hr).padStart(2, '0')}:00  ${pct(a / (c || 1), 2).padStart(7)}  (0% spread: ${pct(a0 / (c0 || 1), 2)})`);
}

// the single best by train: spread sensitivity, weekday, month, year
const champ = byTrain[0]!;
if (champ) {
  console.log('\n=== Champion (best on train): ' + row(champ.k, champ.fl) + ' ===');
  for (const [nm, t] of [['0%', t0], ['2%', t2], ['4%', t4]] as const) { const st = stats(t, champ.k); console.log(`  spread ${nm}: n=${st.n} mean ${pct(st.mean, 2)} win ${pct(st.win, 0)} stop ${pct(st.stop, 0)} worst ${pct(st.worst, 0)}`); }
  const l = label(champ.k);
  const dayOf = (e: number) => new Date((slotSec(t2, l.s, e) + 19800) * 1000);
  console.log('  by weekday of entry (IST):');
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((nm, wd) => { const st = stats(t2, champ.k, 0, NE, (e) => dayOf(e).getUTCDay() === wd); console.log(`   ${nm} n=${st.n} mean ${pct(st.mean, 2)} win ${pct(st.win, 0)} stop ${pct(st.stop, 0)} worst ${pct(st.worst, 0)}`); });
  console.log('  by month:');
  const months = new Set<string>(); for (let e = 0; e < NE; e++) months.add(dayOf(e).toISOString().slice(0, 7));
  for (const m of [...months].sort()) { const st = stats(t2, champ.k, 0, NE, (e) => dayOf(e).toISOString().slice(0, 7) === m); if (st.n) console.log(`   ${m} n=${st.n} sum ${pct(st.sum, 1)} win ${pct(st.win, 0)} stop ${pct(st.stop, 0)}`); }
}

// best combination per weekday of entry (IST), picked on TRAIN only, judged on TEST
console.log('\n=== Per weekday of entry (IST): best on train (n>=25 in train), then its TEST result, spread 2% ===');
['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((nm, wd) => {
  let best: { k: number; tr: St } | null = null;
  const cache = new Map<number, (e: number) => boolean>();
  for (let k = 0; k < K; k++) {
    const s = Math.floor(k / NH / ND);
    let f = cache.get(s); if (!f) { f = (e: number) => new Date((slotSec(t2, s, e) + 19800) * 1000).getUTCDay() === wd; cache.set(s, f); }
    const tr = stats(t2, k, 0, split, f); if (tr.n < 25) continue;
    if (!best || tr.mean > best.tr.mean) best = { k, tr };
  }
  if (!best) return;
  const s = Math.floor(best.k / NH / ND), f = (e: number) => new Date((slotSec(t2, s, e) + 19800) * 1000).getUTCDay() === wd;
  const te = stats(t2, best.k, split, NE, f), te0 = stats(t0, best.k, split, NE, f), te4 = stats(t4, best.k, split, NE, f);
  console.log(`${nm}: ${row(best.k, best.tr, te)}  | test @0% ${pct(te0.mean, 2)} @4% ${pct(te4.mean, 2)}`);
});
