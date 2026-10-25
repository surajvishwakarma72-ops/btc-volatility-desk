/**
 * Final five-year short-strangle search: NEXT or N2N expiry, OTM delta, entry hour, hold, stop and an entry GATE.
 *
 *   npx tsx src/backtest/steps/strangle_final_5y.ts
 *
 * Three periods, so nothing is judged on data it was picked on:
 *   TRAIN   2021-11 -> 2024-04   (find candidates)
 *   VALID   2024-04 -> 2025-10   (confirm; candidates must hold here too)
 *   HOLDOUT 2025-10 -> 2026-10   (never used to pick; also re-run with the REAL archived IV)
 * Same pricing model as strangle_search_5y.ts: Binance 15m, DVOL x k as flat IV, BS repricing, spread and Delta fees.
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
const SPREAD_PCT = Number(process.env.SPREAD_PCT ?? 0.012);
const SPREAD_MIN = Number(process.env.SPREAD_MIN ?? 1);
const REAL_MODE = process.env.REAL === '1';
const TAG = (process.env.SPREAD_PCT ? `_spread${process.env.SPREAD_PCT}` : '') + (REAL_MODE ? '_realiv' : '');

// ---------- data ----------
const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
const barAt = new Map<number, { o: number; h: number; l: number; c: number }>();
for (const r of raw) barAt.set(r[0]! * 1000, { o: r[1]!, h: r[2]!, l: r[3]!, c: r[4]! });
const dv = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), 'utf8')) as number[][];
const dvMs = dv.map((r) => r[0]! * 1000);
const dvVal = dv.map((r) => r[1]!);
function dvolAt(t: number): number | null {
  if (t < dvMs[0]!) return null;
  let lo = 0, hi = dvMs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (dvMs[m]! <= t) lo = m; else hi = m - 1; }
  return t - dvMs[lo]! > 6 * HOUR ? null : dvVal[lo]!;
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

// ---------- grid ----------
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DELTAS = [0.05, 0.08, 0.1, 0.125, 0.15, 0.2];
const EXPIRIES = [1, 2]; // index into the listed expiries: 1 = next, 2 = N2N
const EXP_NAME = ['next', 'N2N'];
const HOLDS = [6, 12, 24];
const STOPS = [0, 2, 3];
const GATES = ['none', 'DVOL<55', 'DVOL falling 24h', 'DVOL above its 30d median', 'IV richer than 24h RV'];
const N_BASE = HOURS.length * DELTAS.length * EXPIRIES.length * HOLDS.length * STOPS.length;
const bid = (h: number, d: number, e: number, ho: number, s: number) => (((h * DELTAS.length + d) * EXPIRIES.length + e) * HOLDS.length + ho) * STOPS.length + s;
const unid = (id: number) => {
  const s = id % STOPS.length; id = (id - s) / STOPS.length;
  const ho = id % HOLDS.length; id = (id - ho) / HOLDS.length;
  const e = id % EXPIRIES.length; id = (id - e) / EXPIRIES.length;
  const d = id % DELTAS.length; const h = (id - d) / DELTAS.length;
  return { hourIst: HOURS[h]!, delta: DELTAS[d]!, expiry: EXPIRIES[e]!, holdH: HOLDS[ho]!, stop: STOPS[s]! };
};

// ---------- simulation ----------
const spread = (m: number) => Math.max(m * SPREAD_PCT, SPREAD_MIN);
const feeOf = (price: number, spot: number) => optionFee({ price, lots: LOTS, contractValue: CV, spot, rate: 0.0001, premiumCapRate: 0.035 });
interface Path { eC: number; eP: number; feeIn: number; margin: number; n: number; spot: number; cC: Float64Array; pC: Float64Array; cW: Float64Array; pW: Float64Array }

function pathFor(t0: number, delta: number, expIdx: number, sigma: (e: number, t: number) => number | null): Path | null {
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
  const N = 96;
  const p: Path = {
    eC: Math.max(mc - spread(mc), 0.05), eP: Math.max(mp - spread(mp), 0.05), feeIn: 0, margin: 0, n: 0, spot: spot0,
    cC: new Float64Array(N + 1), pC: new Float64Array(N + 1), cW: new Float64Array(N + 1), pW: new Float64Array(N + 1),
  };
  p.feeIn = feeOf(p.eC, spot0) + feeOf(p.eP, spot0);
  for (let j = 1; j <= N; j++) {
    const t = t0 + j * 900_000;
    const b = barAt.get(t - 900_000);
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

// ---------- entry gates (information available at the entry time only) ----------
const sortedDv = dvVal;
function rollingMedian30d(t: number): number | null {
  // median of hourly DVOL over the previous 30 days
  let hi = 0; { let lo = 0, h2 = dvMs.length - 1; while (lo < h2) { const m = (lo + h2 + 1) >> 1; if (dvMs[m]! <= t) lo = m; else h2 = m - 1; } hi = lo; }
  const from = Math.max(0, hi - 720);
  if (hi - from < 300) return null;
  const a = sortedDv.slice(from, hi + 1).sort((x, y) => x - y);
  return a[a.length >> 1]!;
}
function rv24(t: number): number | null {
  const r: number[] = [];
  let prev: number | null = null;
  for (let j = 96; j >= 1; j--) {
    const b = barAt.get(t - j * 900_000);
    if (!b) return null;
    if (prev != null) r.push(Math.log(b.c / prev));
    prev = b.c;
  }
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(35040) * 100;
}
function gatesAt(t: number): boolean[] {
  const d = dvolAt(t), d24 = dvolAt(t - DAY), med = rollingMedian30d(t), rv = rv24(t);
  return [
    true,
    d != null && d < 55,
    d != null && d24 != null && d < d24,
    d != null && med != null && d > med,
    d != null && rv != null && d * K > rv,
  ];
}

// ---------- run ----------
const FIRST = REAL_MODE ? Date.UTC(2025, 9, 6) : Date.UTC(2021, 10, 30);
const LAST = Date.UTC(2026, 9, 20);
const P1 = REAL_MODE ? Date.UTC(2026, 2, 1) : Date.UTC(2024, 3, 25);
const P2 = REAL_MODE ? Date.UTC(2026, 5, 15) : Date.UTC(2025, 9, 25);
const days: number[] = [];
for (let d = FIRST; d <= LAST; d += DAY) days.push(d);
const pnl = Array.from({ length: N_BASE }, () => new Float64Array(days.length).fill(NaN));
const stp = Array.from({ length: N_BASE }, () => new Uint8Array(days.length));
const mgSum = new Float64Array(N_BASE), mgN = new Float64Array(N_BASE);
const gateOk = GATES.map(() => new Uint8Array(days.length * 24));

const t0 = Date.now();
for (let di = 0; di < days.length; di++) {
  const mid = days[di]! - IST;
  for (let h = 0; h < 24; h++) {
    const te = mid + h * HOUR;
    gatesAt(te).forEach((g, gi) => { gateOk[gi]![di * 24 + h] = g ? 1 : 0; });
    for (let d = 0; d < DELTAS.length; d++) {
      for (let e = 0; e < EXPIRIES.length; e++) {
        const p = pathFor(te, DELTAS[d]!, EXPIRIES[e]!, REAL_MODE ? realSigma : dvolSigma);
        if (!p) continue;
        for (let ho = 0; ho < HOLDS.length; ho++) {
          for (let s = 0; s < STOPS.length; s++) {
            const id = bid(h, d, e, ho, s);
            const [v, st] = evalVariant(p, HOLDS[ho]! * 4, STOPS[s]!);
            pnl[id]![di] = v; stp[id]![di] = st ? 1 : 0; mgSum[id] += p.margin; mgN[id]++;
          }
        }
      }
    }
  }
  if (di % 300 === 0) console.log(`day ${di}/${days.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ---------- stats ----------
interface St { n: number; mean: number; total: number; win: number; stop: number; t: number; dd: number }
function stat(id: number, gate: number, from: number, to: number): St {
  const a = pnl[id]!, s = stp[id]!, h = unid(id).hourIst, g = gateOk[gate]!;
  let n = 0, sum = 0, sq = 0, w = 0, sp = 0, eq = 0, top = 0, dd = 0;
  for (let i = 0; i < days.length; i++) {
    if (days[i]! < from || days[i]! >= to || !g[i * 24 + h]) continue;
    const v = a[i]!;
    if (!Number.isFinite(v)) continue;
    n++; sum += v; sq += v * v; if (v > 0) w++; sp += s[i]!; eq += v; top = Math.max(top, eq); dd = Math.max(dd, top - eq);
  }
  const mean = n ? sum / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max((sq - n * mean * mean) / (n - 1), 0)) : 0;
  return { n, mean, total: sum, win: n ? w / n : 0, stop: n ? sp / n : 0, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, dd };
}
const usd = (v: number, d = 2) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}`;
const lab = (c: { id: number; gate: number }) => {
  const u = unid(c.id);
  return `IST ${String(u.hourIst).padStart(2, '0')}:00 | ${EXP_NAME[EXPIRIES.indexOf(u.expiry)]} expiry | delta ${u.delta} | hold ${u.holdH}h | stop ${u.stop ? u.stop + 'x' : 'none'} | gate: ${GATES[c.gate]}`;
};

const MIN_N = REAL_MODE ? 40 : 120; // trades per period, so a gate that fires twice a year cannot win
const all: Array<{ id: number; gate: number; tr: St; va: St; ho: St }> = [];
for (let id = 0; id < N_BASE; id++) {
  for (let g = 0; g < GATES.length; g++) {
    all.push({ id, gate: g, tr: stat(id, g, FIRST, P1), va: stat(id, g, P1, P2), ho: stat(id, g, P2, LAST + DAY) });
  }
}
const N_TESTS = all.length;
console.log(`${N_TESTS} rule sets in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const lines: string[] = [];
const out = (s = '') => { lines.push(s); console.log(s); };
out('# Final short-strangle search: next or N2N expiry, OTM delta, entry hour, hold, stop, entry gate');
out(`Pricing: DVOL x ${K.toFixed(3)} as flat IV, Black-Scholes, ${(SPREAD_PCT * 100).toFixed(1)}% half-spread (min $${SPREAD_MIN}), Delta fees + GST, 100 lots/leg. ${N_BASE} base rules x ${GATES.length} gates = ${N_TESTS} rule sets.`);
out(`Periods: TRAIN ${new Date(FIRST).toISOString().slice(0, 10)}..${new Date(P1).toISOString().slice(0, 10)} | VALID ..${new Date(P2).toISOString().slice(0, 10)} | HOLDOUT ..${new Date(LAST).toISOString().slice(0, 10)} (never used to pick).`);
out();

const okN = all.filter((c) => c.tr.n >= MIN_N && c.va.n >= MIN_N);
const posTV = okN.filter((c) => c.tr.mean > 0 && c.va.mean > 0);
out('## How widespread is profit?');
out(`Rule sets with enough trades in train and validation: ${okN.length}. Positive in train: ${okN.filter((c) => c.tr.mean > 0).length}. Positive in train AND validation: ${posTV.length}. Of those, positive in the untouched holdout: ${posTV.filter((c) => c.ho.mean > 0).length} (${posTV.length ? ((posTV.filter((c) => c.ho.mean > 0).length / posTV.length) * 100).toFixed(0) : 0}%).`);
const bonfT = 4.3; // about 0.05 / ${N_TESTS}
out(`Train t >= ${bonfT} (bar for ${N_TESTS} tests): ${okN.filter((c) => c.tr.t >= bonfT).length}; also valid t >= 2: ${okN.filter((c) => c.tr.t >= bonfT && c.va.t >= 2).length}.`);
for (let g = 0; g < GATES.length; g++) {
  const s = okN.filter((c) => c.gate === g);
  const m = (f: (c: (typeof all)[number]) => number) => s.length ? s.reduce((a, c) => a + f(c), 0) / s.length : 0;
  out(`Gate "${GATES[g]}": ${s.length} sets, average per trade train ${usd(m((c) => c.tr.mean))} | valid ${usd(m((c) => c.va.mean))} | holdout ${usd(m((c) => c.ho.mean))}; positive in train+valid: ${s.filter((c) => c.tr.mean > 0 && c.va.mean > 0).length}`);
}
for (let e = 0; e < EXPIRIES.length; e++) {
  const s = okN.filter((c) => unid(c.id).expiry === EXPIRIES[e]);
  const m = (f: (c: (typeof all)[number]) => number) => s.length ? s.reduce((a, c) => a + f(c), 0) / s.length : 0;
  out(`Expiry ${EXP_NAME[e]}: average per trade train ${usd(m((c) => c.tr.mean))} | valid ${usd(m((c) => c.va.mean))} | holdout ${usd(m((c) => c.ho.mean))}; positive in train+valid: ${s.filter((c) => c.tr.mean > 0 && c.va.mean > 0).length}`);
}
out();

const score = (c: (typeof all)[number]) => Math.min(c.tr.t, c.va.t);
const picks = [...posTV].sort((a, b) => score(b) - score(a)).slice(0, 15);
const row = (c: (typeof all)[number]) =>
  `${lab(c)} || train ${usd(c.tr.mean)} t=${c.tr.t.toFixed(1)} (n ${c.tr.n}) | valid ${usd(c.va.mean)} t=${c.va.t.toFixed(1)} (n ${c.va.n}) | HOLDOUT ${usd(c.ho.mean)} t=${c.ho.t.toFixed(1)} (n ${c.ho.n}) win ${(c.ho.win * 100).toFixed(0)}% stop ${(c.ho.stop * 100).toFixed(0)}%`;
out('## Top 15 by the weaker of train/valid t-stat (picked WITHOUT looking at the holdout), shown with their holdout');
for (const c of picks) out(row(c));
out();

// real-IV re-check of the leading picks on the last 13 months
out('## Leading picks re-run with the REAL archived IV (last 13 months)');
const REAL_FROM = Date.UTC(2025, 9, 5);
const realCheck: Array<{ c: (typeof all)[number]; n: number; mean: number; t: number }> = [];
for (const c of picks.slice(0, 10)) {
  const u = unid(c.id);
  const v: number[] = [];
  for (const dayMs of days) {
    if (dayMs < REAL_FROM) continue;
    const te = dayMs - IST + u.hourIst * HOUR;
    const gi = days.indexOf(dayMs);
    if (!gateOk[c.gate]![gi * 24 + u.hourIst]) continue;
    const p = pathFor(te, u.delta, u.expiry, realSigma);
    if (p) v.push(evalVariant(p, u.holdH * 4, u.stop)[0]);
  }
  const mean = v.reduce((s, x) => s + x, 0) / Math.max(v.length, 1);
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(v.length - 1, 1));
  const t = sd ? mean / (sd / Math.sqrt(v.length)) : 0;
  realCheck.push({ c, n: v.length, mean, t });
  out(`${lab(c)} || real-IV ${v.length} trades: ${usd(mean)}/trade, total ${usd(mean * v.length, 0)}, t=${t.toFixed(1)}`);
}
out();

// ---------- decision ----------
const final = realCheck.filter((r) => r.c.ho.mean > 0 && r.mean > 0).sort((a, b) => b.c.ho.t - a.c.ho.t)[0]?.c;
out('## Verdict');
if (!final) {
  out('No rule set was positive in train, validation, the untouched holdout AND the real-IV re-check. There is no short strangle in this grid that the data supports trading.');
  const least = [...okN].sort((a, b) => (b.tr.mean + b.va.mean + b.ho.mean) - (a.tr.mean + a.va.mean + a.ho.mean))[0]!;
  out(`Least bad overall (average of the three periods): ${row(least)}`);
} else {
  out(`Best rule set that passed every stage: ${lab(final)}`);
  out(`Train ${usd(final.tr.mean)}/trade (n ${final.tr.n}), valid ${usd(final.va.mean)} (n ${final.va.n}), holdout ${usd(final.ho.mean)} (n ${final.ho.n}); holdout win ${(final.ho.win * 100).toFixed(0)}%, stop rate ${(final.ho.stop * 100).toFixed(0)}%, holdout max drawdown ${usd(final.ho.dd, 0)}.`);
  const mg = mgN[final.id]! ? mgSum[final.id]! / mgN[final.id]! : 0;
  out(`Average portfolio margin per trade ${usd(mg, 0)}; holdout mean as % of margin ${((final.ho.mean / Math.max(mg, 1)) * 100).toFixed(2)}% per trade.`);
  const u = unid(final.id);
  const yr: string[] = [];
  for (const [n, a, b] of [['2021-22', Date.UTC(2021, 10, 1), Date.UTC(2022, 9, 25)], ['2022-23', Date.UTC(2022, 9, 25), Date.UTC(2023, 9, 25)], ['2023-24', Date.UTC(2023, 9, 25), Date.UTC(2024, 9, 25)], ['2024-25', Date.UTC(2024, 9, 25), Date.UTC(2025, 9, 25)], ['2025-26', Date.UTC(2025, 9, 25), Date.UTC(2026, 9, 25)]] as Array<[string, number, number]>) {
    const s = stat(final.id, final.gate, a, b);
    yr.push(`${n} ${usd(s.mean)} (n ${s.n})`);
  }
  out('By year: ' + yr.join(' | '));
  const wd = Array.from({ length: 7 }, () => ({ n: 0, s: 0 }));
  for (let i = 0; i < days.length; i++) {
    const v = pnl[final.id]![i]!;
    if (!Number.isFinite(v) || !gateOk[final.gate]![i * 24 + u.hourIst]) continue;
    const w = new Date(days[i]! + 12 * HOUR).getUTCDay();
    wd[w]!.n++; wd[w]!.s += v;
  }
  out('By weekday: ' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `${n} ${usd(wd[i]!.s / Math.max(wd[i]!.n, 1))} (n ${wd[i]!.n})`).join(' | '));
}

// ---------- fixed candidates that looked good on the real-IV months: how do they do on the five-year DVOL model? ----------
if (!REAL_MODE) {
  out();
  out('## Evening candidates (found on the 13 real-IV months) checked on the five-year model, by year');
  const YR: Array<[string, number, number]> = [['2021-22', Date.UTC(2021, 10, 1), Date.UTC(2022, 9, 25)], ['2022-23', Date.UTC(2022, 9, 25), Date.UTC(2023, 9, 25)], ['2023-24', Date.UTC(2023, 9, 25), Date.UTC(2024, 9, 25)], ['2024-25', Date.UTC(2024, 9, 25), Date.UTC(2025, 9, 25)], ['2025-26', Date.UTC(2025, 9, 25), Date.UTC(2026, 9, 25)]];
  const cands: Array<[number, number, number, number, number, number]> = [];
  for (const dl of [0.1, 0.125, 0.15, 0.2]) cands.push([19, 2, dl, 24, 0, 2]);
  for (const dl of [0.1, 0.15, 0.2]) cands.push([21, 1, dl, 12, 0, 2]);
  for (const dl of [0.1, 0.15, 0.2]) cands.push([19, 2, dl, 24, 0, 0]);
  for (const [h, e, dl, ho, s, g] of cands) {
    const id = bid(h, DELTAS.indexOf(dl), EXPIRIES.indexOf(e), HOLDS.indexOf(ho), STOPS.indexOf(s));
    const all5 = stat(id, g, FIRST, LAST + DAY);
    out(lab({ id, gate: g }) + ' || 5y n ' + all5.n + ' mean ' + usd(all5.mean) + ' t=' + all5.t.toFixed(1) + ' win ' + (all5.win * 100).toFixed(0) + '% | ' + YR.map(([n, a, b]) => { const x = stat(id, g, a, b); return n + ' ' + usd(x.mean) + ' (n ' + x.n + ')'; }).join(' | '));
  }
}
out(`Caveat: ${N_TESTS} rule sets were compared, so even a rule that passes all stages may be luck; flat IV ignores skew; spreads are assumed, not recorded.`);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `strangle_final_5y${TAG}.md`), lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
console.log('wrote strangle_final_5y' + TAG + '.md');
