/**
 * Five-year search for a profitable short strangle: entry time x delta x hold x stop x take-profit.
 *
 *   npx tsx src/backtest/steps/strangle_search_5y.ts
 *
 * Needs the caches from data/fetch-5y.ts. Method, and what it cannot tell you:
 *  - Underlying: Binance BTCUSDT 15m candles (Oct 2021 - Oct 2026). IV: Deribit DVOL (30-day index) times a
 *    scale k calibrated against the real archived ATM IV of the N2N expiry over the last 13 months. Options are
 *    Black-Scholes repriced with one flat IV per time (no skew), a 1.2% half-spread (min $1) and Delta's fee model.
 *  - Every combo trades EVERY day (no gate). 100 lots per leg, sold on the third (N2N) expiry.
 *  - Search on the first 3.5 years (train), judge on the last 1.5 years (test). With thousands of combos the best
 *    train result is usually luck, so only combos that also hold up out of sample and in most years count.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionFee } from '../../lib/bot/costs.js';
import { portfolioMargin } from '../../lib/bot/portfolio-margin.js';
import { expiriesAfter } from '../../lib/bot/replay.js';
import { bs, roundStrike, strike, yrs } from '../lib/pricing.js';
import { loadData } from '../data/load.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(here, '../data/cache');
const OUT = path.resolve(here, '../output');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const IST = 19_800_000;
const LOTS = 100;
const CV = 0.001;
const HALF_SPREAD_PCT = Number(process.env.SPREAD_PCT ?? 0.012);
const HALF_SPREAD_MIN = Number(process.env.SPREAD_MIN ?? 1);

// ---------- data ----------
const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
const barAt = new Map<number, { o: number; h: number; l: number; c: number }>();
for (const r of raw) barAt.set(r[0]! * 1000, { o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]! });
const dvolRaw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), 'utf8')) as number[][];
const dvolMs = dvolRaw.map((r) => r[0]! * 1000);
const dvolVal = dvolRaw.map((r) => r[1]!);
function dvolAt(t: number): number | null {
  let lo = 0;
  let hi = dvolMs.length - 1;
  if (t < dvolMs[0]!) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (dvolMs[m]! <= t) lo = m; else hi = m - 1; }
  return t - dvolMs[lo]! > 6 * HOUR ? null : dvolVal[lo]!;
}

// ---------- IV scale: real N2N ATM IV vs DVOL over the 13 months where both exist ----------
const real = loadData();
function calibrate(): { k: number; n: number; byQuarter: Array<[string, number]> } {
  const ratios: number[] = [];
  const q = new Map<string, number[]>();
  for (let day = Date.UTC(2025, 9, 5); day < Date.UTC(2026, 9, 18); day += DAY) {
    const t = day + 4.5 * HOUR;
    const ex = expiriesAfter(t)[2]!;
    const iv = real.ivAt(new Date(ex).toISOString().slice(0, 10), t);
    const dv = dvolAt(t);
    if (iv && dv) {
      ratios.push(iv / dv);
      const key = new Date(day).toISOString().slice(0, 7);
      (q.get(key) ?? q.set(key, []).get(key)!).push(iv / dv);
    }
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? NaN;
  return { k: med(ratios), n: ratios.length, byQuarter: [...q.entries()].map(([m, a]) => [m, med(a)] as [string, number]) };
}
const cal = calibrate();
const K = Number.isFinite(cal.k) ? cal.k : 1;
console.log(`IV scale k = ${K.toFixed(3)} (N2N ATM IV / DVOL, median of ${cal.n} days)`);

// ---------- grid ----------
const ENTRY_HOURS_IST = Array.from({ length: 24 }, (_, i) => i);
const DELTAS = [0.05, 0.08, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3];
const HOLDS_H = [3, 6, 12, 24];
const STOPS = [0, 2, 3]; // 0 = no stop; otherwise multiple of the sold price
const TPS = [0, 0.5]; // 0 = none; otherwise fraction of the premium collected
const N_COMBO = ENTRY_HOURS_IST.length * DELTAS.length * HOLDS_H.length * STOPS.length * TPS.length;
const comboId = (h: number, d: number, ho: number, s: number, t: number) => ((((h * DELTAS.length + d) * HOLDS_H.length + ho) * STOPS.length + s) * TPS.length + t);
const comboLabel = (id: number) => {
  const t = id % TPS.length; id = (id - t) / TPS.length;
  const s = id % STOPS.length; id = (id - s) / STOPS.length;
  const ho = id % HOLDS_H.length; id = (id - ho) / HOLDS_H.length;
  const d = id % DELTAS.length; const h = (id - d) / DELTAS.length;
  return { hourIst: ENTRY_HOURS_IST[h]!, delta: DELTAS[d]!, holdH: HOLDS_H[ho]!, stop: STOPS[s]!, tp: TPS[t]! };
};

// ---------- one entry: the path of both legs for 24h ----------
type SigmaFn = (expiryMs: number, t: number) => number | null;
interface Path {
  entryCall: number; entryPut: number; feeIn: number; margin: number;
  n: number;
  callC: Float64Array; putC: Float64Array; callW: Float64Array; putW: Float64Array; feeAt: Float64Array; // feeAt unused placeholder
  exitSpreadCall: Float64Array; exitSpreadPut: Float64Array;
}

const feeOf = (price: number, spot: number) => optionFee({ price, lots: LOTS, contractValue: CV, spot, rate: 0.0001, premiumCapRate: 0.035 });
const spread = (mark: number) => Math.max(mark * HALF_SPREAD_PCT, HALF_SPREAD_MIN);
const dvolSigma: SigmaFn = (_e, t) => { const d = dvolAt(t); return d == null ? null : d * K; };

function pathFor(t0: number, delta: number, sigma: SigmaFn): Path | null {
  const b0 = barAt.get(t0);
  if (!b0) return null;
  const spot0 = b0.o;
  const exp = expiriesAfter(t0)[2]!;
  const s0 = sigma(exp, t0);
  if (s0 == null || !(s0 > 0)) return null;
  const T0 = yrs(exp - t0);
  const Kc = roundStrike(strike(spot0, T0, s0, delta, 'c'), spot0, 'c');
  const Kp = roundStrike(strike(spot0, T0, s0, delta, 'p'), spot0, 'p');
  const mc = bs(spot0, Kc, T0, s0, 'c');
  const mp = bs(spot0, Kp, T0, s0, 'p');
  const entryCall = Math.max(mc - spread(mc), 0.05);
  const entryPut = Math.max(mp - spread(mp), 0.05);
  const N = 96;
  const p: Path = {
    entryCall, entryPut, feeIn: feeOf(entryCall, spot0) + feeOf(entryPut, spot0), margin: 0, n: 0,
    callC: new Float64Array(N + 1), putC: new Float64Array(N + 1), callW: new Float64Array(N + 1), putW: new Float64Array(N + 1), feeAt: new Float64Array(0),
    exitSpreadCall: new Float64Array(N + 1), exitSpreadPut: new Float64Array(N + 1),
  };
  for (let j = 1; j <= N; j++) {
    const t = t0 + j * 900_000;
    const b = barAt.get(t - 900_000);
    if (!b) break;
    const s = sigma(exp, t) ?? s0;
    const Tr = yrs(Math.max(exp - t, 60_000));
    p.callC[j] = Math.max(bs(b.c, Kc, Tr, s, 'c'), 0.05);
    p.putC[j] = Math.max(bs(b.c, Kp, Tr, s, 'p'), 0.05);
    p.callW[j] = Math.max(bs(b.h, Kc, Tr, s, 'c'), 0.05);
    p.putW[j] = Math.max(bs(b.l, Kp, Tr, s, 'p'), 0.05);
    p.n = j;
  }
  if (p.n < 12) return null;
  p.margin = portfolioMargin(
    [
      { type: 'call', side: 'short', strike: Kc, expiryMs: exp, lots: LOTS, iv: s0 },
      { type: 'put', side: 'short', strike: Kp, expiryMs: exp, lots: LOTS, iv: s0 },
    ],
    spot0, t0, CV,
  ).margin;
  return p;
}

/** Net PnL of one rule set over a path. Returns [net, exitedByStop]. */
function evalVariant(p: Path, holdBars: number, stop: number, tp: number): [number, boolean] {
  const last = Math.min(holdBars, p.n);
  const premium = (p.entryCall + p.entryPut) * LOTS * CV;
  let exitCall = p.callC[last]!;
  let exitPut = p.putC[last]!;
  let stopped = false;
  for (let j = 1; j <= last; j++) {
    if (stop > 0) {
      const sc = p.entryCall * stop;
      const sp = p.entryPut * stop;
      const hitC = p.callW[j]! >= sc;
      const hitP = p.putW[j]! >= sp;
      if (hitC || hitP) {
        exitCall = hitC ? Math.max(sc, p.callC[j]!) : p.callC[j]!;
        exitPut = hitP ? Math.max(sp, p.putC[j]!) : p.putC[j]!;
        stopped = true;
        break;
      }
    }
    if (tp > 0) {
      const gross = (p.entryCall - p.callC[j]! + p.entryPut - p.putC[j]!) * LOTS * CV;
      if (gross >= tp * premium) { exitCall = p.callC[j]!; exitPut = p.putC[j]!; break; }
    }
  }
  const px = (m: number) => m + spread(m);
  const ec = px(exitCall);
  const ep = px(exitPut);
  const spotApprox = 80_000; // fee base only: the fee is capped by the premium share at these sizes
  const fees = p.feeIn + feeOf(ec, spotApprox) + feeOf(ep, spotApprox);
  return [(p.entryCall - ec + p.entryPut - ep) * LOTS * CV - fees, stopped];
}

// ---------- the search ----------
const FIRST_DAY = Date.UTC(2021, 10, 2);
const LAST_DAY = Date.UTC(2026, 9, 20);
const SPLIT = Date.UTC(2025, 3, 25);
const days: number[] = [];
for (let d = FIRST_DAY; d <= LAST_DAY; d += DAY) days.push(d);
const pnl = Array.from({ length: N_COMBO }, () => new Float64Array(days.length).fill(NaN));
const stoppedArr = Array.from({ length: N_COMBO }, () => new Uint8Array(days.length));
const marginSum = new Float64Array(N_COMBO);
const marginN = new Float64Array(N_COMBO);

const t0 = Date.now();
for (let di = 0; di < days.length; di++) {
  const istMidnight = days[di]! - IST + DAY - DAY; // IST midnight of the IST date whose UTC date is days[di]
  for (let h = 0; h < ENTRY_HOURS_IST.length; h++) {
    const te = istMidnight + ENTRY_HOURS_IST[h]! * HOUR;
    for (let d = 0; d < DELTAS.length; d++) {
      const p = pathFor(te, DELTAS[d]!, dvolSigma);
      if (!p) continue;
      for (let ho = 0; ho < HOLDS_H.length; ho++) {
        for (let s = 0; s < STOPS.length; s++) {
          for (let tp = 0; tp < TPS.length; tp++) {
            const id = comboId(h, d, ho, s, tp);
            const [v, st] = evalVariant(p, HOLDS_H[ho]! * 4, STOPS[s]!, TPS[tp]!);
            pnl[id]![di] = v;
            stoppedArr[id]![di] = st ? 1 : 0;
            marginSum[id] += p.margin;
            marginN[id]++;
          }
        }
      }
    }
  }
  if (di % 200 === 0) console.log(`day ${di}/${days.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`simulated ${N_COMBO} combos x ${days.length} days in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---------- statistics ----------
interface Stat { n: number; mean: number; total: number; win: number; stop: number; t: number; dd: number }
function stat(id: number, from: number, to: number): Stat {
  const a = pnl[id]!;
  const st = stoppedArr[id]!;
  let n = 0, sum = 0, sq = 0, wins = 0, stops = 0, eq = 0, top = 0, dd = 0;
  for (let i = 0; i < days.length; i++) {
    if (days[i]! < from || days[i]! >= to) continue;
    const v = a[i]!;
    if (!Number.isFinite(v)) continue;
    n++; sum += v; sq += v * v; if (v > 0) wins++; stops += st[i]!;
    eq += v; top = Math.max(top, eq); dd = Math.max(dd, top - eq);
  }
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max((sq - n * mean * mean) / (n - 1), 0)) : 0;
  return { n, mean, total: sum, win: n ? wins / n : 0, stop: n ? stops / n : 0, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, dd };
}
const YEARS: Array<[string, number, number]> = [
  ['2021-22', Date.UTC(2021, 10, 1), Date.UTC(2022, 9, 25)],
  ['2022-23', Date.UTC(2022, 9, 25), Date.UTC(2023, 9, 25)],
  ['2023-24', Date.UTC(2023, 9, 25), Date.UTC(2024, 9, 25)],
  ['2024-25', Date.UTC(2024, 9, 25), Date.UTC(2025, 9, 25)],
  ['2025-26', Date.UTC(2025, 9, 25), Date.UTC(2026, 9, 25)],
];
const all = Array.from({ length: N_COMBO }, (_, id) => {
  const train = stat(id, FIRST_DAY, SPLIT);
  const test = stat(id, SPLIT, LAST_DAY + DAY);
  const yearly = YEARS.map(([, a, b]) => stat(id, a, b).mean);
  return { id, ...comboLabel(id), train, test, yearly, posYears: yearly.filter((m) => m > 0).length, mgn: marginN[id]! ? marginSum[id]! / marginN[id]! : 0 };
});

const usd = (v: number, d = 2) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}`;
const fmt = (c: (typeof all)[number]) =>
  `IST ${String(c.hourIst).padStart(2, '0')}:00 | delta ${String(c.delta).padEnd(5)} | hold ${String(c.holdH).padStart(2)}h | stop ${c.stop ? c.stop + 'x' : 'none'} | tp ${c.tp ? c.tp * 100 + '%' : 'none'}`;
const row = (c: (typeof all)[number]) =>
  `${fmt(c)} || train ${usd(c.train.mean)}/tr t=${c.train.t.toFixed(1)} win ${(c.train.win * 100).toFixed(0)}% | test ${usd(c.test.mean)}/tr t=${c.test.t.toFixed(1)} win ${(c.test.win * 100).toFixed(0)}% | yrs+ ${c.posYears}/5 [${c.yearly.map((m) => m.toFixed(1)).join(', ')}]`;

const lines: string[] = [];
const out = (s = '') => { lines.push(s); console.log(s); };

out('# Five-year short strangle search');
out(`Data: Binance 15m ${new Date(raw[0]![0]! * 1000).toISOString().slice(0, 10)} to ${new Date(raw[raw.length - 1]![0]! * 1000).toISOString().slice(0, 10)}, DVOL x ${K.toFixed(3)} as flat IV (calibrated on ${cal.n} days of real N2N ATM IV; monthly ratios ${cal.byQuarter.map(([m, v]) => `${m} ${v.toFixed(2)}`).join(', ')}).`);
out(`Grid: ${ENTRY_HOURS_IST.length} entry hours (IST) x ${DELTAS.length} deltas x ${HOLDS_H.length} holds x ${STOPS.length} stops x ${TPS.length} take-profits = ${N_COMBO} combos, each traded every day, ${LOTS} lots/leg, N2N expiry. Train ${new Date(FIRST_DAY).toISOString().slice(0, 10)} to ${new Date(SPLIT).toISOString().slice(0, 10)}, test after.`);
out('Costs: 1.2% half-spread (min $1) each way, Delta option fee + GST. No gate, no skew, flat IV.');
out();

const posTrain = all.filter((c) => c.train.mean > 0);
const posBoth = all.filter((c) => c.train.mean > 0 && c.test.mean > 0);
const BONF_T = 4.1; // about 0.05 / 4608 one-sided
const passTrain = all.filter((c) => c.train.t >= BONF_T);
out(`## Is profit widespread?`);
out(`Combos with a positive average in TRAIN: ${posTrain.length}/${N_COMBO} (${((posTrain.length / N_COMBO) * 100).toFixed(1)}%). Positive in BOTH train and test: ${posBoth.length} (${((posBoth.length / N_COMBO) * 100).toFixed(1)}%).`);
out(`Train t-stat of at least ${BONF_T} (the bar for ${N_COMBO} tests): ${passTrain.length}. Of those, still positive in test: ${passTrain.filter((c) => c.test.mean > 0).length}; with test t >= 2: ${passTrain.filter((c) => c.test.t >= 2).length}.`);
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
out(`Median combo: train ${usd(med(all.map((c) => c.train.mean)))}/trade, test ${usd(med(all.map((c) => c.test.mean)))}/trade.`);
out();

out('## Top 15 by TRAIN t-stat (what the search would have picked), with their TEST result');
for (const c of [...all].sort((a, b) => b.train.t - a.train.t).slice(0, 15)) out(row(c));
out();

const robust = all
  .filter((c) => c.train.mean > 0 && c.test.mean > 0 && c.train.t >= 3 && c.test.t >= 1.5 && c.posYears >= 4)
  .sort((a, b) => Math.min(b.train.t, b.test.t * 2) - Math.min(a.train.t, a.test.t * 2));
out(`## Robust candidates (train>0, test>0, train t>=3, test t>=1.5, positive in >=4 of 5 years): ${robust.length}`);
for (const c of robust.slice(0, 20)) out(row(c));
out();

out('## Best by entry hour (highest train mean among combos, with its test result)');
for (let h = 0; h < 24; h++) {
  const best = all.filter((c) => c.hourIst === h).sort((a, b) => b.train.t - a.train.t)[0]!;
  out(`${String(h).padStart(2, '0')}:00 IST  ${row(best).slice(row(best).indexOf('|') + 2)}`);
}
out();

out('## Average over all combos, by delta / hold / stop / tp (train | test mean per trade)');
const grp = (key: (c: (typeof all)[number]) => string) => {
  const m = new Map<string, Array<(typeof all)[number]>>();
  for (const c of all) { const k = key(c); (m.get(k) ?? m.set(k, []).get(k)!).push(c); }
  for (const [k, v] of m) out(`${k.padEnd(10)} train ${usd(v.reduce((s, c) => s + c.train.mean, 0) / v.length)} | test ${usd(v.reduce((s, c) => s + c.test.mean, 0) / v.length)} | stop rate ${(v.reduce((s, c) => s + c.train.stop, 0) / v.length * 100).toFixed(0)}%`);
};
out('-- delta'); grp((c) => String(c.delta));
out('-- hold'); grp((c) => `${c.holdH}h`);
out('-- stop'); grp((c) => (c.stop ? `${c.stop}x` : 'none'));
out('-- take profit'); grp((c) => (c.tp ? `${c.tp * 100}%` : 'none'));
out();

// ---------- re-check the leading candidates with the REAL archived IV (last 13 months) ----------
const realSigma: SigmaFn = (e, t) => real.ivAt(new Date(e).toISOString().slice(0, 10), t);
const picks = (robust.length ? robust : [...all].sort((a, b) => b.train.t - a.train.t)).slice(0, 8);
out(`## Re-check on the last 13 months with the REAL archived N2N IV instead of DVOL x k (${robust.length ? 'robust candidates' : 'no robust candidates, so the top train picks'})`);
const REAL_FROM = Date.UTC(2025, 9, 5);
for (const c of picks) {
  let n = 0, sum = 0, wins = 0;
  const dayPnl: number[] = [];
  for (const dayMs of days) {
    if (dayMs < REAL_FROM) continue;
    const te = dayMs - IST + c.hourIst * HOUR;
    const p = pathFor(te, c.delta, realSigma);
    if (!p) continue;
    const [v] = evalVariant(p, c.holdH * 4, c.stop, c.tp);
    n++; sum += v; if (v > 0) wins++; dayPnl.push(v);
  }
  const mean = n ? sum / n : 0;
  const sd = Math.sqrt(dayPnl.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(n - 1, 1));
  out(`${fmt(all[c.id]!)} || real-IV ${n} days: ${usd(mean)}/trade (total ${usd(sum, 0)}, win ${((wins / Math.max(n, 1)) * 100).toFixed(0)}%, t=${sd ? (mean / (sd / Math.sqrt(n))).toFixed(1) : '0'})`);
}
out();

// ---------- the single best robust combo in detail ----------
const star = (robust[0] ?? [...all].sort((a, b) => b.train.t - a.train.t)[0])!;
out(`## Detail: ${fmt(star)}`);
out(`Train: n=${star.train.n} mean ${usd(star.train.mean)} total ${usd(star.train.total, 0)} win ${(star.train.win * 100).toFixed(0)}% stop ${(star.train.stop * 100).toFixed(0)}% maxDD ${usd(star.train.dd, 0)}`);
out(`Test:  n=${star.test.n} mean ${usd(star.test.mean)} total ${usd(star.test.total, 0)} win ${(star.test.win * 100).toFixed(0)}% stop ${(star.test.stop * 100).toFixed(0)}% maxDD ${usd(star.test.dd, 0)}`);
out(`Avg portfolio margin per trade ${usd(star.mgn, 0)}; mean/trade as % of margin: train ${((star.train.mean / star.mgn) * 100).toFixed(2)}%, test ${((star.test.mean / star.mgn) * 100).toFixed(2)}%`);
const wd = Array.from({ length: 7 }, () => ({ n: 0, s: 0 }));
for (let i = 0; i < days.length; i++) { const v = pnl[star.id]![i]!; if (!Number.isFinite(v)) continue; const w = new Date(days[i]! + 12 * HOUR).getUTCDay(); wd[w]!.n++; wd[w]!.s += v; }
out('By weekday (IST entry date): ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `${n} ${usd(wd[i]!.s / Math.max(wd[i]!.n, 1))}`).join(' | '));
out('By year (mean/trade): ' + YEARS.map(([n], i) => `${n} ${usd(star.yearly[i]!)}`).join(' | '));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'strangle_search_5y.md'), lines.join('\n') + '\n');
console.log(`\nwrote ${path.join(OUT, 'strangle_search_5y.md')}`);
