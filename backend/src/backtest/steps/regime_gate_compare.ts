/**
 * Strangle Pulse Phase 3A, Task 2: compare candidate regime gates for the short strangle on five years of BTC data.
 *
 *   npx tsx src/backtest/steps/regime_gate_compare.ts      (run in backend/)
 *
 * One short strangle per UTC hour at :00, delta 0.125, 100 lots/leg, stop 2x on each leg's entry bid, no take-profit,
 * closed at the earlier of the stop and the next 12:00 UTC roll. Run for the Next (index 1) and N2N (index 2) expiry.
 * Pricing and path logic are copied from strangle_final_5y.ts (DVOL x K as flat IV, Black-Scholes, spread, Delta fees).
 * Gate inputs use only information available at the entry time (hour bars completed at or before it, DVOL candles
 * closed at or before it) and the Task 1 indicator functions. Writes docs/superpowers/reports/2026-10-31-regime-gate-backtest.md.
 * The report states numbers; it does not recommend a gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optionFee } from '../../lib/bot/costs.js';
import { portfolioMargin } from '../../lib/bot/portfolio-margin.js';
import { expiriesAfter } from '../../lib/bot/replay.js';
import { hourReturns, ivOverRv, regimeState, rvWindow, type Bar1h } from '../../lib/pulse/regime/indicators.js';
import { bs, roundStrike, strike, yrs } from '../lib/pricing.js';
import { loadData } from '../data/load.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(here, '../data/cache');
const REPORT_DIR = path.resolve(here, '../../../../docs/superpowers/reports');
const REPORT = path.join(REPORT_DIR, '2026-10-31-regime-gate-backtest.md');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const IST = 19_800_000;
const Q = 900_000; // one 15m bar
const LOTS = 100;
const CV = 0.001;
const SPREAD_PCT = 0.012;
const SPREAD_MIN = 1;
const DELTA = 0.125;
const STOP = 2;
const MAX_BARS = 9300; // newest completed hour bars handed to regimeState
const MIN_N = 120; // fewer passed cohorts than this in a period = THIN
// Fewer distinct rolls than this in a period = LOW-ROLLS. Cohorts sharing a roll share most of their path, so the roll is
// the real unit of independent outcomes; under ~30 rolls the roll-clustered SE itself is too unstable to compare on.
const MIN_ROLLS = 30;
const NL = String.fromCharCode(10);
const tStart = Date.now();

// ---------- data (as strangle_final_5y.ts) ----------
const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
const barAt = new Map<number, { o: number; h: number; l: number; c: number }>();
for (const r of raw) barAt.set(r[0]! * 1000, { o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]! });
const dv = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), 'utf8')) as number[][];
const dvMs = dv.map((r) => r[0]! * 1000);
const dvVal = dv.map((r) => r[1]!);
/** Harness DVOL lookup (row stamped at or before t, null if older than 6h). Used for PRICING only, exactly as the harness. */
function dvolAt(t: number): number | null {
  if (t < dvMs[0]!) return null;
  let lo = 0, hi = dvMs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (dvMs[m]! <= t) lo = m; else hi = m - 1; }
  return t - dvMs[lo]! > 6 * HOUR ? null : dvVal[lo]!;
}
/**
 * DVOL as of te for the GATES. A cached row [t, v] is the close of the 1h candle that opened at t, so it is known only at
 * t + 1h. Use the newest candle with t + 1h <= te; null when that close is older than 6h.
 */
function dvolAsOf(te: number): number | null {
  return dvolAt(te - HOUR);
}
const real = loadData();
const realSigma = (e: number, t: number) => real.ivAt(new Date(e).toISOString().slice(0, 10), t);
function calibrate(): number {
  const r: number[] = [];
  for (let day = Date.UTC(2025, 9, 5); day < Date.UTC(2026, 9, 18); day += DAY) {
    const t = day + 4.5 * HOUR;
    const iv = realSigma(expiriesAfter(t)[2]!, t);
    const d = dvolAt(t);
    if (iv && d) r.push(iv / d);
  }
  return r.sort((a, b) => a - b)[Math.floor(r.length / 2)] ?? 1;
}
const K = calibrate();
const dvolSigma = (_e: number, t: number) => { const d = dvolAt(t); return d == null ? null : d * K; };
console.log(`IV scale k=${K.toFixed(3)}, spread ${(SPREAD_PCT * 100).toFixed(1)}% min $${SPREAD_MIN}`);

// ---------- hourly bars from the 15m cache ----------
for (let i = 1; i < raw.length; i++) if (!(raw[i]![0]! > raw[i - 1]![0]!)) throw new Error('15m cache not strictly ascending');
/** Group 15m rows into 1h bars: open of the first, high max, low min, close of the last 15m bar in the hour. */
function buildHourBars(rows: readonly number[][]): Bar1h[] {
  const out: Bar1h[] = [];
  for (const r of rows) {
    const t = Math.floor((r[0]! * 1000) / HOUR) * HOUR;
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, r[2]!); last.l = Math.min(last.l, r[3]!); last.c = r[4]!; }
    else out.push({ t, o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]! });
  }
  return out;
}
const hBars = buildHourBars(raw);
const hT = Float64Array.from(hBars, (b) => b.t);
/** Number of hour bars with t <= x. */
function countAtOrBefore(x: number): number {
  let lo = 0, hi = hT.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (hT[m]! <= x) lo = m + 1; else hi = m; }
  return lo;
}

// ---------- simulation (copied from strangle_final_5y.ts; path length = bars to the roll) ----------
const spread = (m: number) => Math.max(m * SPREAD_PCT, SPREAD_MIN);
const feeOf = (price: number, spot: number) => optionFee({ price, lots: LOTS, contractValue: CV, spot, rate: 0.0001, premiumCapRate: 0.035 });
interface Path { eC: number; eP: number; feeIn: number; margin: number; n: number; spot: number; cC: Float64Array; pC: Float64Array; cW: Float64Array; pW: Float64Array }

function pathFor(t0: number, delta: number, expIdx: number, sigma: (e: number, t: number) => number | null, N = 96): Path | null {
  const b0 = barAt.get(t0);
  if (!b0) return null;
  const spot0 = b0.o;
  const exp = expiriesAfter(t0)[expIdx]!;
  const s0 = sigma(exp, t0);
  if (s0 == null || !(s0 > 0)) return null;
  const T0 = yrs(exp - t0);
  const Kc = roundStrike(strike(spot0, T0, s0, delta, 'c'), spot0, 'c');
  const Kp = roundStrike(strike(spot0, T0, s0, delta, 'p'), spot0, 'p');
  const mc = bs(spot0, Kc, T0, s0, 'c');
  const mp = bs(spot0, Kp, T0, s0, 'p');
  const p: Path = {
    eC: Math.max(mc - spread(mc), 0.05), eP: Math.max(mp - spread(mp), 0.05), feeIn: 0, margin: 0, n: 0, spot: spot0,
    cC: new Float64Array(N + 1), pC: new Float64Array(N + 1), cW: new Float64Array(N + 1), pW: new Float64Array(N + 1),
  };
  p.feeIn = feeOf(p.eC, spot0) + feeOf(p.eP, spot0);
  for (let j = 1; j <= N; j++) {
    const t = t0 + j * Q;
    const b = barAt.get(t - Q);
    if (!b) break;
    const s = sigma(exp, t) ?? s0;
    const Tr = yrs(Math.max(exp - t, 60_000));
    p.cC[j] = Math.max(bs(b.c, Kc, Tr, s, 'c'), 0.05);
    p.pC[j] = Math.max(bs(b.c, Kp, Tr, s, 'p'), 0.05);
    p.cW[j] = Math.max(bs(b.h, Kc, Tr, s, 'c'), 0.05);
    p.pW[j] = Math.max(bs(b.l, Kp, Tr, s, 'p'), 0.05);
    p.n = j;
  }
  if (p.n < 12) return null;
  p.margin = portfolioMargin(
    [{ type: 'call', side: 'short', strike: Kc, expiryMs: exp, lots: LOTS, iv: s0 }, { type: 'put', side: 'short', strike: Kp, expiryMs: exp, lots: LOTS, iv: s0 }],
    spot0, t0, CV,
  ).margin;
  return p;
}

function evalVariant(p: Path, holdBars: number, stop: number): [number, boolean] {
  const last = Math.min(holdBars, p.n);
  let xc = p.cC[last]!, xp = p.pC[last]!, stopped = false;
  if (stop > 0) {
    const sc = p.eC * stop, sp = p.eP * stop;
    for (let j = 1; j <= last; j++) {
      const hc = p.cW[j]! >= sc, hp = p.pW[j]! >= sp;
      if (hc || hp) { xc = hc ? Math.max(sc, p.cC[j]!) : p.cC[j]!; xp = hp ? Math.max(sp, p.pC[j]!) : p.pC[j]!; stopped = true; break; }
    }
  }
  const ec = xc + spread(xc), ep = xp + spread(xp);
  const fees = p.feeIn + feeOf(ec, p.spot) + feeOf(ep, p.spot);
  return [(p.eC - ec + p.eP - ep) * LOTS * CV - fees, stopped];
}

// ---------- gate inputs at entry time te (no lookahead) ----------
interface Inputs { dvol: number; ivrv24: number; ivrv7: number; adx: number; killer: number; nBars: number; lastBarT: number }
const nn = (v: number | null | undefined) => (v == null ? NaN : v);
/** All inputs at te from a list of hour bars (ascending). Only bars with t + 1h <= te are used; the newest 9,300 go in. */
function inputsAt(te: number, allBars: readonly Bar1h[], nDone: number, dvolNow: number | null): Inputs {
  const bars = allBars.slice(Math.max(0, nDone - MAX_BARS), nDone);
  const st = regimeState(bars, te);
  const rets = hourReturns(bars, te);
  const rv24 = rvWindow(rets, te, 24);
  const rv7 = rvWindow(rets, te, 168);
  const iv = dvolNow == null ? null : (dvolNow * K) / 100;
  return {
    dvol: nn(dvolNow),
    ivrv24: nn(ivOverRv(iv, rv24)),
    ivrv7: nn(ivOverRv(iv, rv7)),
    adx: nn(st?.adx),
    killer: st == null || st.killer == null ? 2 : st.killer ? 1 : 0,
    nBars: bars.length,
    lastBarT: bars.length ? bars[bars.length - 1]!.t : NaN,
  };
}

// ---------- run ----------
const FIRST = Date.UTC(2021, 10, 30);
const LAST = Date.UTC(2026, 9, 20);
const P1 = Date.UTC(2024, 3, 25);
const P2 = Date.UTC(2025, 9, 25);
const END = LAST + DAY;
const PERIODS: Array<[string, number, number]> = [['TRAIN', FIRST, P1], ['VALID', P1, P2], ['HOLDOUT', P2, END]];
const nDays = (END - FIRST) / DAY;
const NH = nDays * 24;
const EXPIRIES = [1, 2];
const EXP_NAME = ['Next', 'N2N'];
const teOf = (i: number) => FIRST + i * HOUR;

const inDvol = new Float64Array(NH).fill(NaN);
const inIvrv24 = new Float64Array(NH).fill(NaN);
const inIvrv7 = new Float64Array(NH).fill(NaN);
const inAdx = new Float64Array(NH).fill(NaN);
const inKill = new Uint8Array(NH).fill(2); // 0 not killer, 1 killer, 2 unknown
const holdOf = new Uint8Array(NH); // 0 = skipped (fewer than 12 bars to the roll)
const pnl = EXPIRIES.map(() => new Float64Array(NH).fill(NaN));
const stp = EXPIRIES.map(() => new Uint8Array(NH));
const mg = EXPIRIES.map(() => new Float64Array(NH));
let skippedRoll = 0, lookaheadViolations = 0;

const tLoop = Date.now();
for (let di = 0; di < nDays; di++) {
  for (let h = 0; h < 24; h++) {
    const i = di * 24 + h;
    const te = teOf(i);
    const roll = expiriesAfter(te)[0]!; // next 12:00 UTC strictly after te
    const hb = Math.min(96, Math.round((roll - te) / Q));
    if (hb < 12) { skippedRoll++; continue; }
    holdOf[i] = hb;
    const nDone = countAtOrBefore(te - HOUR); // hour bars that ended at or before te
    const x = inputsAt(te, hBars, nDone, dvolAsOf(te));
    if (Number.isFinite(x.lastBarT) && x.lastBarT + HOUR > te) lookaheadViolations++;
    inDvol[i] = x.dvol; inIvrv24[i] = x.ivrv24; inIvrv7[i] = x.ivrv7; inAdx[i] = x.adx; inKill[i] = x.killer;
    for (let e = 0; e < EXPIRIES.length; e++) {
      const p = pathFor(te, DELTA, EXPIRIES[e]!, dvolSigma, hb);
      if (!p) continue;
      const [v, s] = evalVariant(p, hb, STOP);
      pnl[e]![i] = v; stp[e]![i] = s ? 1 : 0; mg[e]![i] = p.margin;
    }
  }
  if (di % 300 === 0) console.log(`day ${di}/${nDays} ${((Date.now() - tLoop) / 1000).toFixed(0)}s`);
}
const loopSec = (Date.now() - tLoop) / 1000;
console.log(`loop done in ${loopSec.toFixed(0)}s; lookahead violations ${lookaheadViolations}`);
if (lookaheadViolations) throw new Error('lookahead: a bar newer than the entry was used');

// ---------- gates ----------
// A condition returns 1 pass, 0 fail, 2 input unavailable. A gate passes when all its conditions pass; any unavailable
// input fails the gate and is counted as 'unavailable'.
type Cond = { name: string; f: (i: number) => 0 | 1 | 2 };
const gt = (a: Float64Array, v: number, name: string): Cond => ({ name, f: (i) => (Number.isNaN(a[i]!) ? 2 : a[i]! > v ? 1 : 0) });
const lt = (a: Float64Array, v: number, name: string): Cond => ({ name, f: (i) => (Number.isNaN(a[i]!) ? 2 : a[i]! < v ? 1 : 0) });
const C = {
  ivrv24_13: gt(inIvrv24, 1.3, 'IV/RV24 > 1.3'),
  ivrv24_10: gt(inIvrv24, 1.0, 'IV/RV24 > 1.0'),
  ivrv7_13: gt(inIvrv7, 1.3, 'IV/RV7 > 1.3'),
  adx15: lt(inAdx, 15, 'ADX < 15'),
  adx25: lt(inAdx, 25, 'ADX < 25'),
  adx40: lt(inAdx, 40, 'ADX < 40'),
  notKiller: { name: 'not killer', f: (i: number) => (inKill[i] === 2 ? 2 : inKill[i] === 0 ? 1 : 0) } as Cond,
  dvol65: lt(inDvol, 65, 'DVOL < 65'),
};
interface Gate { name: string; conds: Cond[]; res: Uint8Array }
const mkGate = (name: string, conds: Cond[]): Gate => {
  const res = new Uint8Array(NH);
  for (let i = 0; i < NH; i++) {
    let r: 0 | 1 | 2 = 1;
    for (const c of conds) { const v = c.f(i); if (v === 2) { r = 2; break; } if (v === 0) r = 0; }
    res[i] = r;
  }
  return { name, conds, res };
};
const MAIN: Gate[] = [
  mkGate('none', []),
  mkGate('spec', [C.ivrv24_13, C.adx15, C.notKiller, C.dvol65]),
  mkGate('spec-RV7', [C.ivrv7_13, C.adx15, C.notKiller, C.dvol65]),
  mkGate('study', [C.ivrv24_10, C.adx40, C.notKiller, C.dvol65]),
  mkGate('spec-no-ADX15', [C.ivrv24_13, C.adx25, C.notKiller, C.dvol65]),
];
const SINGLE: Gate[] = [C.ivrv24_13, C.ivrv24_10, C.adx15, C.adx25, C.adx40, C.notKiller, C.dvol65].map((c) => mkGate(c.name, [c]));

// ---------- stats ----------
// Cluster key: the 12:00 UTC roll that closes the cohort (expiriesAfter(te)[0]), as a day index from FIRST.
const rollIdx = new Int32Array(NH);
for (let i = 0; i < NH; i++) rollIdx[i] = Math.floor((expiriesAfter(teOf(i))[0]! - FIRST) / DAY);
const NR = nDays + 1;
interface St { entries: number; n: number; rolls: number; unavail: number; mean: number; total: number; mgMean: number; win: number; stop: number; rollMean: number; se: number }
const dSum = new Float64Array(NR), dN = new Uint32Array(NR);
function stat(g: Gate, e: number, from: number, to: number, filter?: (i: number) => boolean): St {
  dSum.fill(0); dN.fill(0);
  const a = pnl[e]!, s = stp[e]!, m = mg[e]!;
  let entries = 0, n = 0, sum = 0, w = 0, sp = 0, ms = 0, un = 0;
  const i0 = Math.max(0, (from - FIRST) / HOUR), i1 = Math.min(NH, (to - FIRST) / HOUR);
  for (let i = i0; i < i1; i++) {
    const v = a[i]!;
    if (!Number.isFinite(v)) continue; // no valid path (or skipped near the roll)
    if (filter && !filter(i)) continue;
    entries++;
    const r = g.res[i]!;
    if (r === 2) un++;
    if (r !== 1) continue;
    n++; sum += v; ms += m[i]!; if (v > 0) w++; sp += s[i]!;
    const d = rollIdx[i]!; dSum[d] += v; dN[d]++;
  }
  let rolls = 0, dm = 0, dq = 0;
  for (let d = 0; d < NR; d++) if (dN[d]) { const x = dSum[d]! / dN[d]!; rolls++; dm += x; dq += x * x; }
  const rollMean = rolls ? dm / rolls : NaN;
  const sd = rolls > 1 ? Math.sqrt(Math.max((dq - rolls * rollMean * rollMean) / (rolls - 1), 0)) : NaN;
  return { entries, n, rolls, unavail: un, mean: n ? sum / n : NaN, total: sum, mgMean: n ? ms / n : NaN, win: n ? w / n : NaN, stop: n ? sp / n : NaN, rollMean, se: rolls > 1 ? sd / Math.sqrt(rolls) : NaN };
}
const usd = (v: number, d = 2) => (Number.isFinite(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}` : 'n/a');
const pct = (v: number, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : 'n/a');
const num = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const thin = (s: St) => [s.n < MIN_N ? 'THIN' : '', s.rolls < MIN_ROLLS ? 'LOW-ROLLS' : ''].filter(Boolean).join(' ');
const comparable = (s: St) => s.n >= MIN_N && s.rolls >= MIN_ROLLS;
const HEAD = '| Gate | Expiry | Period | Entries | Passed | Rolls | Pass % | Unavail | Mean/cohort | % of margin | Total (cohort-weighted) | Win | Stop | Roll-mean | SE (roll) | Roll-mean/SE | Flag |';
const SEP = '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|';
const rowOf = (g: Gate, e: number, per: string, s: St) =>
  `| ${g.name} | ${EXP_NAME[e]} | ${per} | ${s.entries} | ${s.n} | ${s.rolls} | ${pct(s.n / s.entries)} | ${s.unavail} | ${usd(s.mean)} | ${pct(s.mean / s.mgMean, 3)} | ${usd(s.total, 0)} | ${pct(s.win, 0)} | ${pct(s.stop, 0)} | ${usd(s.rollMean)} | ${usd(s.se)} | ${num(s.rollMean / s.se)} | ${thin(s)} |`;

const lines: string[] = [];
const out = (s = '') => lines.push(s);
const both = (s = '') => { lines.push(s); console.log(s); };

const res = new Map<string, St>();
const key = (g: string, e: number, p: string) => `${g}|${e}|${p}`;
for (const g of [...MAIN, ...SINGLE]) for (let e = 0; e < EXPIRIES.length; e++) for (const [pn, a, b] of PERIODS) res.set(key(g.name, e, pn), stat(g, e, a, b));
const R = (g: string, e: number, p: string) => res.get(key(g, e, p))!;

out('# Regime gate comparison backtest (Strangle Pulse Phase 3A, Task 2)');
out();
out(`Generated by \`backend/src/backtest/steps/regime_gate_compare.ts\` (run: \`cd backend && npx tsx src/backtest/steps/regime_gate_compare.ts\`). This report states numbers and tradeoffs. It does not recommend a gate.`);
out();
out('## Setup');
out(`- Trade: one short strangle per UTC hour at :00, delta ${DELTA}, ${LOTS} lots per leg, stop ${STOP}x on each leg's entry bid (a stop on either leg closes both), no take-profit, closed at the earlier of the stop and the next 12:00 UTC roll (at most 96 15m bars). Entries with fewer than 12 bars (3 hours) to the roll are skipped, so UTC 10:00 and 11:00 never trade (${skippedRoll} entry hours skipped). Expiry index 1 (Next) and 2 (N2N).`);
out(`- Pricing (copied from \`strangle_final_5y.ts\`): IV proxy = DVOL x K, flat across strikes, with K = ${K.toFixed(4)} calibrated as in that harness (median of real archived N2N IV / DVOL at 04:30 UTC, 2025-10-05 to 2026-10-17). Black-Scholes on Binance 15m bars, half-spread ${(SPREAD_PCT * 100).toFixed(1)}% (min $${SPREAD_MIN}), Delta fees + GST, portfolio margin from \`portfolioMargin\`.`);
out(`- Periods: TRAIN ${new Date(FIRST).toISOString().slice(0, 10)} to ${new Date(P1).toISOString().slice(0, 10)}, VALID to ${new Date(P2).toISOString().slice(0, 10)}, HOLDOUT to ${new Date(LAST).toISOString().slice(0, 10)} (inclusive), by entry time. Same cut points as \`strangle_final_5y.ts\`.`);
out(`- Gate inputs at entry time te, with no lookahead: hour bars built from the 15m cache, using only hours that ended at or before te; the newest ${MAX_BARS} of them go to \`regimeState(bars, te)\` (ADX, killer) and \`hourReturns(bars, te)\`; RV24 = \`rvWindow(rets, te, 24)\`, RV7 = \`rvWindow(rets, te, 168)\`; IV = DVOL x K / 100; IV/RV via \`ivOverRv\`. DVOL is the close of the newest 1h DVOL candle that closed at or before te (null if that close is older than 6h). "DVOL < 65" compares raw DVOL points (not DVOL x K). The regime state is computed once per entry hour and shared by both expiries.`);
out('- Gates: `none`; `spec` = IV/RV24 > 1.3 AND ADX < 15 AND not killer AND DVOL < 65; `spec-RV7` = same with IV/RV7; `study` = IV/RV24 > 1.0 AND ADX < 40 AND not killer AND DVOL < 65; `spec-no-ADX15` = IV/RV24 > 1.3 AND ADX < 25 AND not killer AND DVOL < 65. A gate passes only when all its inputs are available; an unavailable input fails the gate and is counted in "Unavail".');
out();
out('### How to read the tables');
out(`- **Entries**: hourly entries in the period that had a valid price path for that expiry (entry hours with no path, mostly DVOL holes, are not counted; see Limits). **Passed**: cohorts (entries) the gate allowed. **Rolls**: distinct 12:00 UTC rolls that close at least one passed cohort. **Pass %** = Passed / Entries. **Unavail**: entries the gate failed because an input was missing.`);
out('- **Mean/cohort**: mean net P&L per passed cohort (USD, 100 lots per leg). **% of margin** = mean P&L / mean portfolio margin of the passed cohorts. **Total (cohort-weighted)** = sum over passed cohorts; it grows with the number of cohorts, so it is not comparable across gates with different trade counts. **Win** = share with P&L > 0. **Stop** = share closed by the 2x stop.');
out('- **Roll-mean**: every cohort is closed at (or stopped before) one 12:00 UTC roll, and cohorts sharing a roll share most of their price path. So the passed cohorts of each roll are averaged first, and those roll averages are then averaged. It is the P&L of a typical traded roll, whatever the number of hours that passed. **SE (roll)**: standard error of the roll-mean across rolls (roll-clustered). **Roll-mean/SE** is a rough t-value. The roll-mean is the main figure for comparing gates; the per-cohort mean is shown second.');
out(`- **THIN**: fewer than ${MIN_N} passed cohorts in the period. **LOW-ROLLS**: fewer than ${MIN_ROLLS} distinct rolls in the period. Flagged rows are not compared anywhere in this report, and no row is ranked.`);
out();

out('## Headline table: every gate x expiry x period');
out();
out(HEAD); out(SEP);
console.log('');
console.log('Headline (gate | expiry | period | passed/entries | rolls | mean/cohort | stop | roll-mean +/- SE | flag)');
for (const g of MAIN) for (let e = 0; e < EXPIRIES.length; e++) for (const [pn] of PERIODS) {
  const s = R(g.name, e, pn);
  out(rowOf(g, e, pn, s));
  console.log(`${g.name.padEnd(14)} ${EXP_NAME[e]!.padEnd(4)} ${pn.padEnd(7)} ${String(s.n).padStart(6)}/${String(s.entries).padEnd(6)} rolls ${String(s.rolls).padStart(4)} mean ${usd(s.mean).padStart(8)} stop ${pct(s.stop, 0).padStart(4)} roll-mean ${usd(s.rollMean)} +/- ${usd(s.se)} ${thin(s)}`);
}
out();

out('## Ablation: single rules on their own');
out();
out('Each rule alone, same trade and periods. Useful for seeing which condition does the filtering and what each one costs in trade count.');
out();
out(HEAD); out(SEP);
for (const g of SINGLE) for (let e = 0; e < EXPIRIES.length; e++) for (const [pn] of PERIODS) out(rowOf(g, e, pn, R(g.name, e, pn)));
out();

// ---------- weekday and Friday ----------
const istDay = (i: number) => new Date(teOf(i) + IST).getUTCDay();
const fridayEve = (i: number) => { const te = teOf(i); return istDay(i) === 5 && new Date(te).getUTCHours() >= 15 && new Date(te).getUTCHours() <= 18; };
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WDI = [1, 2, 3, 4, 5, 6, 0];
out('## Weekday and Friday evening');
out();
out('Pass rate by IST weekday of the entry, all three periods together, over hourly entries with a valid Next-expiry path. "Fri eve" = Friday IST 20:00-23:59 entries, i.e. UTC hours 15, 16, 17 and 18 (IST 20:30, 21:30, 22:30, 23:30).');
out();
out(`| Gate | ${WD.join(' | ')} | Fri eve |`);
out(`|---|${WD.map(() => '---:').join('|')}|---:|`);
const wdExtremes: string[] = [];
for (const g of MAIN.concat(SINGLE)) {
  const rates = WDI.map((w) => stat(g, 0, FIRST, END, (i) => istDay(i) === w));
  const cells = rates.map((s) => `${pct(s.n / s.entries)} (${s.n})`);
  const f = stat(g, 0, FIRST, END, fridayEve);
  out(`| ${g.name} | ${cells.join(' | ')} | ${pct(f.n / f.entries)} (${f.n}/${f.entries}) |`);
  if (g.name === 'none') continue;
  const r = rates.map((s) => s.n / s.entries);
  const hi = r.indexOf(Math.max(...r)), lo = r.indexOf(Math.min(...r));
  wdExtremes.push(`- \`${g.name}\`: highest on ${WD[hi]} (${pct(r[hi]!)}), lowest on ${WD[lo]} (${pct(r[lo]!)}).`);
}
out();
out('Highest and lowest IST-weekday pass rate per gate (from the table above):');
out();
for (const l of wdExtremes) out(l);
out();
out('Friday evening P&L (UTC 15-18 entries on IST Friday), all five years together, per gate and expiry. All four Friday-evening hours close at the same Saturday 12:00 UTC roll, so Rolls here is the number of Fridays traded:');
out();
out('| Gate | Expiry | Entries | Passed | Rolls | Mean/cohort | Total (cohort-weighted) | Win | Stop | Roll-mean | SE (roll) | Flag |');
out('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|');
for (const g of MAIN) for (let e = 0; e < EXPIRIES.length; e++) {
  const s = stat(g, e, FIRST, END, fridayEve);
  out(`| ${g.name} | ${EXP_NAME[e]} | ${s.entries} | ${s.n} | ${s.rolls} | ${usd(s.mean)} | ${usd(s.total, 0)} | ${pct(s.win, 0)} | ${pct(s.stop, 0)} | ${usd(s.rollMean)} | ${usd(s.se)} | ${thin(s)} |`);
}
out();

// ---------- spec failure reasons ----------
out('## Spec gate: why it fails');
out();
out('Over hourly entries with a valid Next-expiry path. "Unavailable" entries fail before any condition is judged; the input-missing columns say which input was missing (one entry can miss several). For entries with every input available, "fails" counts every entry where the condition is false (they overlap), and "only failure" counts entries where it is the single failing condition.');
out();
const specConds = MAIN[1]!.conds;
out(`| Period | Entries | Passed | Unavailable | ${specConds.map((c) => `${c.name} input missing`).join(' | ')} | Judged and failed | ${specConds.map((c) => `${c.name}: fails`).join(' | ')} | ${specConds.map((c) => `${c.name}: only failure`).join(' | ')} |`);
out(`|---|---:|---:|---:|${specConds.map(() => '---:').join('|')}|---:|${specConds.map(() => '---:').join('|')}|${specConds.map(() => '---:').join('|')}|`);
for (const [pn, a, b] of [...PERIODS, ['ALL', FIRST, END] as [string, number, number]]) {
  let entries = 0, passed = 0, un = 0, judgedFail = 0;
  const miss = specConds.map(() => 0), fails = specConds.map(() => 0), only = specConds.map(() => 0);
  for (let i = (a - FIRST) / HOUR; i < (b - FIRST) / HOUR; i++) {
    if (!Number.isFinite(pnl[0]![i]!)) continue;
    entries++;
    const v = specConds.map((c) => c.f(i));
    if (v.includes(2)) { un++; v.forEach((x, k) => { if (x === 2) miss[k]!++; }); continue; }
    if (v.every((x) => x === 1)) { passed++; continue; }
    judgedFail++;
    v.forEach((x, k) => { if (x === 0) fails[k]!++; });
    if (v.filter((x) => x === 0).length === 1) only[v.indexOf(0)]!++;
  }
  const p = (x: number) => `${x} (${pct(x / entries)})`;
  out(`| ${pn} | ${entries} | ${p(passed)} | ${p(un)} | ${miss.map(p).join(' | ')} | ${p(judgedFail)} | ${fails.map(p).join(' | ')} | ${only.map(p).join(' | ')} |`);
}
out();

// ---------- what this says (generated from the numbers; no recommendation) ----------
out('## What this says');
out();
out('Each gate compared with taking every entry (`none`), in plain words. The roll-mean is the primary comparison (with both SEs); the per-cohort mean is secondary. These are tradeoffs, not a ranking; THIN and LOW-ROLLS rows are not compared. Being selective has costs: fewer rolls traded and a wider error band. Totals are cohort-weighted and are not used to compare gates. Pass rates differ by IST weekday; see the weekday table and the per-gate highest/lowest lines.');
out();
const sd = (v: number) => `${v >= 0 ? '+' : '-'}${usd(Math.abs(v))}`;
for (let e = 0; e < EXPIRIES.length; e++) {
  out(`### ${EXP_NAME[e]} expiry`);
  for (const [pn] of PERIODS) {
    const b = R('none', e, pn);
    out(`- **${pn}**: taking every entry: roll-mean ${usd(b.rollMean)} +/- ${usd(b.se)} over ${b.rolls} rolls (${b.n} cohorts), stop rate ${pct(b.stop, 0)}; per-cohort mean ${usd(b.mean)}.`);
    for (const g of MAIN.slice(1)) {
      const s = R(g.name, e, pn);
      if (!comparable(s)) { out(`  - \`${g.name}\`: ${thin(s)} (${s.n} cohorts on ${s.rolls} rolls, ${pct(s.n / s.entries)} of entries). Too few to compare with \`none\`; its roll-mean ${usd(s.rollMean)} is not evidence either way.`); continue; }
      const dRoll = s.rollMean - b.rollMean, dMean = s.mean - b.mean, dStop = s.stop - b.stop;
      const verdict = dRoll < 0 ? 'worse than taking every entry on the roll-mean' : 'better than taking every entry on the roll-mean';
      out(`  - \`${g.name}\`: roll-mean ${usd(s.rollMean)} +/- ${usd(s.se)} vs ${usd(b.rollMean)} +/- ${usd(b.se)} for \`none\`: ${sd(dRoll)}, ${verdict}. Keeps ${pct(s.n / s.entries)} of entries (${s.n} cohorts, ${s.rolls} of ${b.rolls} rolls). Stop rate ${pct(s.stop, 0)} (${dStop >= 0 ? '+' : ''}${(dStop * 100).toFixed(0)} points vs \`none\`). Secondary: per-cohort mean ${usd(s.mean)} (${sd(dMean)} vs \`none\`).${Math.abs(s.mean - s.rollMean) > s.se ? ' The per-cohort mean and roll-mean differ by more than one SE: rolls with many passing hours carry the per-cohort mean.' : ''}`);
    }
  }
  const signs = (g: string) => PERIODS.map(([pn]) => {
    const s = R(g, e, pn);
    if (!comparable(s)) return thin(s);
    const t = s.rollMean / s.se;
    return `${Math.abs(t) < 2 ? '~0' : t > 0 ? '+' : '-'} (t ${t.toFixed(1)})`;
  }).join(' / ');
  out(`- **Roll-mean sign TRAIN / VALID / HOLDOUT** ('~0' when |t| < 2): ${MAIN.map((g) => `\`${g.name}\` ${signs(g.name)}`).join('; ')}.`);
  out();
}
out('Read each line as: how much trading is given up, what that buys in stop rate and roll-mean P&L, and whether the result holds across TRAIN, VALID and HOLDOUT. A roll-mean that changes sign between periods, or that is within about two SE of zero, is not a stable edge in this model.');
out();

// ---------- DVOL hole facts (computed from the cache) ----------
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const holes: Array<{ from: number; hours: number }> = [];
for (let j = 1; j < dvMs.length; j++) {
  const gap = dvMs[j]! - dvMs[j - 1]!;
  if (gap > HOUR) holes.push({ from: dvMs[j - 1]! + HOUR, hours: Math.round(gap / HOUR) - 1 });
}
const holeHours = holes.reduce((s, h) => s + h.hours, 0);
const hMin = holes.length ? Math.min(...holes.map((h) => h.hours)) : 0, hMax = holes.length ? Math.max(...holes.map((h) => h.hours)) : 0;
const holeSize = hMin === hMax ? String(hMin) : `${hMin} to ${hMax}`;
const spacing = holes.slice(1).map((h, k) => (h.from - holes[k]!.from) / DAY).sort((a, b) => a - b);
const medianGapDays = spacing.length ? spacing[spacing.length >> 1]!.toFixed(0) : 'n/a';
let entryHours = 0, noPathHours = 0, dvolUnavail = 0;
for (let i = 0; i < NH; i++) {
  if (!holdOf[i]) continue;
  entryHours++;
  if (!Number.isFinite(pnl[0]![i]!)) noPathHours++;
  else if (Number.isNaN(inDvol[i]!)) dvolUnavail++;
}
console.log(`DVOL holes ${holes.length}, ${holeHours}h; entry hours ${entryHours}, no Next path ${noPathHours}, valid-path but DVOL unavailable ${dvolUnavail}`);

// ---------- limits ----------
out('## Limits');
out();
out(`- **IV is a flat proxy**: DVOL x K (K = ${K.toFixed(4)}), the same for every strike and both expiries, so skew and term structure are ignored. The earlier real-IV re-check (\`strangle_final_5y_realiv.md\`) found that rules positive on this proxy were negative with real archived IV over the last 13 months, so positive numbers here can overstate the real result.`);
out('- **Pricing reads DVOL as the harness does**: the copied pricing marks options with the DVOL row stamped at or before each mark time, and a row is the close of the hour that starts at that stamp, so marks can use a DVOL value up to one hour newer than the mark time. This affects option marks only, not the gate inputs (those use DVOL candles that had closed by te). It was kept so the trade model matches `strangle_final_5y.ts`.');
out('- **One path**: five years of one BTC history. Gates were defined beforehand, but TRAIN/VALID/HOLDOUT are still one sequence of markets. The SE is clustered by roll, which handles cohorts that share an exit, but volatility regimes persist across neighbouring rolls, so the SE still understates the true uncertainty.');
out('- **Not backtestable, excluded**: the event calendar (macro stress) and GEX. Any gate that uses them live will behave differently from what is shown.');
out(`- **Roll skip**: entries with fewer than 12 bars (3 hours) to the 12:00 UTC roll are skipped (UTC 10:00 and 11:00). Hold length depends on entry hour (from 12 bars at 09:00 UTC to 96 at 12:00 UTC).`);
out(`- **DVOL holes drop entries silently**: the DVOL cache has ${holes.length} holes of ${holeSize} hours each, ${holeHours.toLocaleString('en-US')} missing hours in total, from ${holes.length ? isoDay(holes[0]!.from) : 'n/a'} to ${holes.length ? isoDay(holes[holes.length - 1]!.from) : 'n/a'}, about one every ${medianGapDays} days (median spacing between holes). The cause: \`fetch-5y.ts\` requests DVOL in 50-day chunks (1,200 hourly candles), the API returns about 1,000 candles per call, and so part of each chunk is never fetched. The data was not re-fetched. During a hole the price path has no IV, so ${noPathHours.toLocaleString('en-US')} of ${entryHours.toLocaleString('en-US')} entry hours (${pct(noPathHours / entryHours)}) have no Next-expiry price path. They drop out of Entries, Rolls and every statistic, without appearing anywhere else. Only ${dvolUnavail} entries with a valid path have no gate DVOL (DVOL as of te is older than 6h), and those land in "Unavail". The holes follow the calendar (fetch chunk boundaries), not market conditions, so they remove the same hours for every gate. The same holes exist in \`strangle_final_5y.ts\` and in its K calibration.`);
out('- **Unavailable inputs**: early in TRAIN the regime state needs 60 completed UTC days of RV; those entries fail every gate that needs ADX or killer and are counted in "Unavail".');
out(`- **K overlaps HOLDOUT**: K is calibrated on 2025-10-05 to 2026-10-17, which overlaps HOLDOUT. The IV-based gates (IV/RV) are therefore slightly fitted to the holdout. K is the same constant for every gate.`);
out('- **Spreads and fees are assumed** (1.2% half-spread, min $1), not recorded quotes.');
out();

// ---------- sanity checks ----------
const checks: string[] = [];
let allOk = true;
const check = (ok: boolean, text: string) => { checks.push(`- ${ok ? 'PASS' : 'FAIL'}: ${text}`); if (!ok) allOk = false; };
for (let e = 0; e < EXPIRIES.length; e++) for (const [pn] of PERIODS) {
  const s = R('none', e, pn);
  check(s.n === s.entries && s.unavail === 0, `\`none\` passes ${s.n} of ${s.entries} valid-path entries (${pct(s.n / s.entries, 2)}), ${EXP_NAME[e]} ${pn}.`);
}
for (let e = 0; e < EXPIRIES.length; e++) for (const [pn] of PERIODS) {
  const a = R('ADX < 40', e, pn).n, b = R('ADX < 25', e, pn).n, c = R('ADX < 15', e, pn).n;
  check(a > b && b > c, `ADX monotonic, ${EXP_NAME[e]} ${pn}: ADX<40 ${a} > ADX<25 ${b} > ADX<15 ${c}.`);
}
// Harness replica: re-create one line of strangle_final_5y.md with the copied pricing (IST 05:00 entry, Next, delta
// 0.125, hold 12h, stop 2x, gate "IV richer than 24h RV", harness's own rv24 and DVOL lookup).
function harnessRv24(t: number): number | null {
  const r: number[] = [];
  let prev: number | null = null;
  for (let j = 96; j >= 1; j--) {
    const b = barAt.get(t - j * Q);
    if (!b) return null;
    if (prev != null) r.push(Math.log(b.c / prev));
    prev = b.c;
  }
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(35040) * 100;
}
const rep = PERIODS.map(() => ({ n: 0, s: 0 }));
for (let d = FIRST; d <= LAST; d += DAY) {
  const te = d - IST + 5 * HOUR;
  const dd = dvolAt(te), rv = harnessRv24(te);
  if (!(dd != null && rv != null && dd * K > rv)) continue;
  const p = pathFor(te, 0.125, 1, dvolSigma);
  if (!p) continue;
  const v = evalVariant(p, 48, 2)[0];
  const k = d < P1 ? 0 : d < P2 ? 1 : 2;
  rep[k]!.n++; rep[k]!.s += v;
}
const repTxt = rep.map((r, k) => `${PERIODS[k]![0]} ${usd(r.s / r.n)} (n ${r.n})`).join(', ');
const expected = [[1.25, 533], [2.9, 291], [0.24, 145]];
const repOk = rep.every((r, k) => r.n === expected[k]![1] && Math.abs(r.s / r.n - expected[k]![0]!) < 0.006);
check(repOk, `Pricing replica of \`strangle_final_5y.md\` line "IST 05:00 | next | delta 0.125 | hold 12h | stop 2x | gate: IV richer than 24h RV" (train $1.25 n 533, valid $2.90 n 291, holdout $0.24 n 145): this script gives ${repTxt}.`);
const noneNext = PERIODS.map(([pn]) => R('none', 0, pn));
checks.push(`- SKIPPED (no matching line): \`strangle_final_5y.md\` has no line for the \`none\` gate with this exact rule (hourly entries at UTC :00, hold to the 12:00 UTC roll). Its nearest reference is the average over all 2,592 \`none\` rule sets (train -$0.88, valid -$2.05, holdout -$3.71 per trade, mixed deltas/holds/stops). For information only: this study's \`none\`, Next, delta 0.125, stop 2x gives ${noneNext.map((s, k) => `${PERIODS[k]![0]} ${usd(s.mean)}`).join(', ')}. The replica check above verifies the copied pricing instead.`);
check(lookaheadViolations === 0, `No-lookahead assertion in the loop: newest hour bar used ended at or before te for every entry (${lookaheadViolations} violations).`);

// Spot checks: 20 seeded pseudo-random entries, inputs recomputed from freshly built bars.
let seed = 20261031;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const eligible: number[] = [];
for (let i = 0; i < NH; i++) if (Number.isFinite(pnl[0]![i]!)) eligible.push(i);
const spot: string[] = [];
let spotOk = true;
const same = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;
for (let k = 0; k < 20; k++) {
  const i = eligible[Math.floor(rnd() * eligible.length)]!;
  const te = teOf(i);
  const rows = raw.filter((r) => r[0]! * 1000 + Q <= te); // 15m bars completed at or before te
  const fresh = buildHourBars(rows).filter((b) => b.t + HOUR <= te);
  let fd: number | null = null;
  for (let j = dv.length - 1; j >= 0; j--) if (dv[j]![0]! * 1000 + HOUR <= te) { fd = te - (dv[j]![0]! * 1000 + HOUR) > 6 * HOUR ? null : dv[j]![1]!; break; }
  const x = inputsAt(te, fresh, fresh.length, fd);
  const ok = same(x.dvol, inDvol[i]!) && same(x.ivrv24, inIvrv24[i]!) && same(x.ivrv7, inIvrv7[i]!) && same(x.adx, inAdx[i]!) && x.killer === inKill[i] && x.lastBarT + HOUR <= te;
  if (!ok) spotOk = false;
  spot.push(`| ${new Date(te).toISOString().slice(0, 16)}Z | ${x.nBars} | ${num(x.dvol, 1)} | ${num(x.ivrv24, 3)} | ${num(x.ivrv7, 3)} | ${num(x.adx, 2)} | ${['no', 'yes', 'n/a'][x.killer]} | ${ok ? 'match' : 'MISMATCH'} |`);
}
check(spotOk, '20 seeded spot checks: gate inputs recomputed from freshly built bars (Task 1 functions called directly) equal the values the loop used, exactly.');

const totalSec = (Date.now() - tStart) / 1000;
out('## Sanity checks and verification');
out();
for (const c of checks) out(c);
out();
out(`Spot checks (seed 20261031; 15m rows filtered to bars completed by te, regrouped into hours, last ${MAX_BARS} passed to the Task 1 functions; DVOL found by a linear scan):`);
out();
out('| Entry (UTC) | Bars used | DVOL | IV/RV24 | IV/RV7 | ADX | Killer | vs loop |');
out('|---|---:|---:|---:|---:|---:|---|---|');
for (const s of spot) out(s);
console.log(`Run time: main loop ${loopSec.toFixed(0)}s, total ${totalSec.toFixed(0)}s (console only, not in the report).`);

console.log('');
for (const c of checks) console.log(c);
if (!allOk) {
  console.log('SANITY CHECK FAILED: report NOT written.');
  process.exit(1);
}
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(REPORT, lines.join(NL) + NL);
console.log(`wrote ${REPORT} in ${totalSec.toFixed(0)}s`);
