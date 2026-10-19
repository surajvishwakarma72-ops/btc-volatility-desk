import fs from 'node:fs';
import { db, pool } from '../db/index.js';
import { sql } from 'drizzle-orm';

// --------------------------------------------------------------------------
// Constants & Utility Functions (exact formulas from Volatility Desk)
// --------------------------------------------------------------------------
const MIN = 60000;
const HR = 3600000;
const DAY = 86400000;
const IST = 19800000;

function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function ppf(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function bs(S: number, K: number, T: number, s: number, cp: 'c' | 'p'): number {
  T = Math.max(T, 1e-6);
  s = Math.max(s, 0.01) / 100;
  const v = s * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * s * s * T) / v;
  const d2 = d1 - v;
  return cp === 'c' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
}

function strike(S: number, T: number, s: number, dl: number, cp: 'c' | 'p'): number {
  s = s / 100;
  const d1 = cp === 'c' ? ppf(dl) : ppf(1 - dl);
  return S * Math.exp(-(d1 * s * Math.sqrt(T) - 0.5 * s * s * T));
}

const yrs = (ms: number) => ms / (365 * DAY);
const d0 = (d: string) => Date.parse(d + 'T00:00:00Z') - IST;
const dk = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const keyOf = (idx: number) => new Date(idx * DAY).toISOString().slice(0, 10);

function nthSun(y: number, m: number, n: number): number {
  const d = new Date(Date.UTC(y, m, 1));
  const first = (7 - d.getUTCDay()) % 7;
  return Date.UTC(y, m, 1 + first + 7 * (n - 1));
}

function isEDT(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  return ms >= nthSun(y, 2, 2) + 7 * HR && ms < nthSun(y, 10, 1) + 6 * HR;
}

function frame(now: number) {
  const base = Math.floor((now + IST - 17.5 * HR) / DAY);
  const D0 = base * DAY - IST;
  const edt = isEDT(D0 + 14 * HR);
  const open = D0 + (edt ? 19 : 20) * HR;
  return {
    base,
    D0,
    edt,
    open,
    end: open + 7.5 * HR,
    exit: D0 + 31 * HR, // 07:00 IST next morning
    cur: keyOf(base + 1),
    nxt: keyOf(base + 2),
    n2n: keyOf(base + 3),
    settle: (base + 3) * DAY - IST + 17.5 * HR,
    listing: D0 + 17.5 * HR,
    dow: new Date(base * DAY).getUTCDay(),
  };
}

function at(s: [number, number][], t: number): number | null {
  if (!s || !s.length || t < s[0][0]) return null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (s[m][0] <= t) lo = m;
    else hi = m - 1;
  }
  return s[lo][1];
}

function rvOver(cl: [number, number][], t: number, mins: number): number | null {
  const r: number[] = [];
  for (let i = 1; i < cl.length; i++) {
    if (cl[i][0] > t || cl[i][0] <= t - mins * MIN) continue;
    if (cl[i][0] - cl[i - 1][0] === MIN) r.push(Math.log(cl[i][1] / cl[i - 1][1]));
  }
  if (r.length < mins * 0.6) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1) * 525600) * 100;
}

// --------------------------------------------------------------------------
// Main Analysis Logic
// --------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(75));
  console.log('  STAGE 1 BACKTEST: STOP-LOSS AVOIDANCE CORRELATION ANALYSIS (TRADE CLOCK)');
  console.log('='.repeat(75));

  // 1. Load archive BTC and IV data from browser-data-export.json
  console.log('Loading market archive data...');
  const exportRaw = fs.readFileSync('browser-data-export.json', 'utf-8');
  const exportBundle = JSON.parse(exportRaw);
  const idb = exportBundle.indexedDB || {};
  const archive = idb.suraj_archive_v1?.stores || {};

  const btcMap = new Map<string, any>();
  if (archive.btc) {
    for (const b of archive.btc) {
      const v = b.value || b;
      if (v.day && v.c) btcMap.set(v.day, v);
    }
  }

  const ivMap = new Map<string, any>();
  if (archive.iv) {
    for (const item of archive.iv) {
      const v = item.value || item;
      if (v.e && v.day && v.c) ivMap.set(`${v.e}|${v.day}`, v);
    }
  }
  console.log(`Loaded ${btcMap.size} full 1440m BTC days and ${ivMap.size} IV curves.`);

  // 2. Query Neon PostgreSQL for indicator snapshots
  console.log('Querying Neon PostgreSQL indicator_snapshots...');
  const snapRes: any = await db.execute(sql`
    SELECT 
      recorded_at,
      term_current_n2n,
      term_next_n2n,
      forward_vol,
      n2n_iv,
      skew_25d,
      butterfly,
      atm_iv,
      funding_rate,
      open_interest
    FROM indicator_snapshots
    ORDER BY recorded_at ASC
  `);
  const snapshots: any[] = snapRes.rows || [];
  console.log(`Loaded ${snapshots.length} indicator snapshots from database.`);

  // Build helper to find closest snapshot to timestamp ms
  function getSnapshot(ms: number) {
    const target = new Date(ms).toISOString();
    // binary search or nearest match
    let lo = 0, hi = snapshots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (new Date(snapshots[mid].recorded_at).getTime() < ms) lo = mid + 1;
      else hi = mid;
    }
    const cand = snapshots[lo];
    if (!cand) return null;
    const diff = Math.abs(new Date(cand.recorded_at).getTime() - ms);
    return diff <= 15 * MIN ? cand : null;
  }

  // Helper to extract continuous BTC series and 1m spot bars
  function getBtcSeries(days: string[], from: number, to: number) {
    const cl: [number, number][] = [];
    const H = new Map<number, [number, number, number]>(); // time -> [high, low, close]
    for (const d of days) {
      const r = btcMap.get(d);
      if (!r || !r.c) continue;
      const b = d0(d);
      for (let m = 0; m < 1440; m++) {
        const t = b + m * MIN;
        if (t < from || t > to) continue;
        const c = r.c[m];
        if (!(c > 0)) continue;
        cl.push([t, c]);
        H.set(t, [r.h[m] > 0 ? r.h[m] : c, r.l[m] > 0 ? r.l[m] : c, c]);
      }
    }
    return { cl, H };
  }

  function getIvSeries(e: string, days: string[], from: number, to: number): [number, number][] {
    const out: [number, number][] = [];
    for (const d of days) {
      const r = ivMap.get(`${e}|${d}`);
      if (!r || !r.c) continue;
      const b = d0(d);
      for (let m = 0; m < 1440; m++) {
        const t = b + m * MIN;
        if (t < from || t > to) continue;
        const raw = r.c[m];
        if (Number.isFinite(raw) && raw > 0) {
          const v = raw < 5 ? raw * 100 : raw;
          out.push([t, v]);
        }
      }
    }
    return out;
  }

  // Build hourly bars from btcMap for Wilder ADX(14)
  function dMean(a: number[]): number {
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  }

  function adxSeries(bars: { t: number; o: number; h: number; l: number; c: number }[], n = 14) {
    if (!bars || bars.length < n * 3) return [];
    let tr = 0, pdm = 0, ndm = 0, adx: number | null = null;
    const dxs: number[] = [], out: { t: number; v: number }[] = [];
    for (let i = 1; i < bars.length; i++) {
      const a = bars[i - 1], b = bars[i], up = b.h - a.h, dn = a.l - b.l;
      const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0, t = Math.max(b.h - b.l, Math.abs(b.h - a.c), Math.abs(b.l - a.c));
      if (i <= n) {
        tr += t; pdm += p; ndm += m;
        if (i < n) continue;
      } else {
        tr = tr - tr / n + t; pdm = pdm - pdm / n + p; ndm = ndm - ndm / n + m;
      }
      const pdi = tr > 0 ? 100 * pdm / tr : 0, ndi = tr > 0 ? 100 * ndm / tr : 0;
      const dx = pdi + ndi > 0 ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0;
      if (adx == null) {
        dxs.push(dx);
        if (dxs.length < n) continue;
        adx = dMean(dxs);
      } else {
        adx = (adx * (n - 1) + dx) / n;
      }
      out.push({ t: b.t, v: adx });
    }
    return out;
  }

  const allHourlyBars: { t: number; o: number; h: number; l: number; c: number }[] = [];
  const sortedDays = [...btcMap.keys()].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  for (const d of sortedDays) {
    const r = btcMap.get(d);
    if (!r || !r.c) continue;
    const b = d0(d);
    for (let h = 0; h < 24; h++) {
      const hStart = b + h * HR;
      let o = 0, hi = -Infinity, lo = Infinity, c = 0, count = 0;
      for (let m = 0; m < 60; m++) {
        const minIdx = h * 60 + m;
        const price = r.c[minIdx];
        if (price > 0) {
          if (count === 0) o = price;
          c = price;
          const hPrice = r.h[minIdx] > 0 ? r.h[minIdx] : price;
          const lPrice = r.l[minIdx] > 0 ? r.l[minIdx] : price;
          if (hPrice > hi) hi = hPrice;
          if (lPrice < lo) lo = lPrice;
          count++;
        }
      }
      if (count > 0) {
        allHourlyBars.push({ t: hStart, o, h: hi, l: lo, c });
      }
    }
  }
  const globalAdx = adxSeries(allHourlyBars, 14);
  console.log(`Constructed ${allHourlyBars.length} hourly bars across archive. ADX series length: ${globalAdx.length}`);

  function getAdxAt(t: number) {
    if (!globalAdx.length) return null;
    let v: number | null = null;
    for (const p of globalAdx) {
      if (p.t + HR <= t) v = p.v;
      else break;
    }
    return v;
  }

  // 3. Simulate strangling trades across all days
  const daysList = [...btcMap.keys()].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  console.log(`Evaluating ${daysList.length} calendar days from ${daysList[0]} to ${daysList[daysList.length - 1]}...`);

  interface TradeTest {
    night: string;
    dow: number;
    dowName: string;
    entryTime: number;
    exitTime: number;
    spot0: number;
    iv0: number;
    callStrike: number;
    putStrike: number;
    credit: number;
    stopped: boolean;
    stopLeg: string;
    pnlPct: number;
    win: boolean;
    // Indicators at entry:
    ivVs1730: boolean | null; // true = IV below 17:30
    iv1730Level: number | null;
    speedVsIv: number | null; // RV / IV
    speedUnder15: boolean | null;
    speedUnder10: boolean | null;
    adxFalling: boolean | null;
    ivTurnOffPct: number | null; // % off NY high
    ivTurnValid: boolean | null; // 1.5% - 6.0%
    termBackwardation: boolean | null; // Cur > N2N
    termSpread: number | null;
    skew25d: number | null;
    fundingRate: number | null;
    checksGoodCount: number; // 0, 1, 2, or 3 of (ivVs1730, speedUnder15, adxFalling)
  }

  const allTrades: TradeTest[] = [];

  for (let i = 0; i < daysList.length; i++) {
    const d = daysList[i];
    const n1 = daysList[i + 1];
    if (!n1) continue;

    const F = frame(d0(d) + 20 * HR);
    if (F.dow === 0 || F.dow === 6) continue; // Skip weekends

    const { cl, H } = getBtcSeries([d, n1], d0(d) + 12 * HR, d0(d) + 36 * HR);
    const sN2n = getIvSeries(F.n2n, [d, n1], d0(d) + 12 * HR, d0(d) + 36 * HR);
    const sCur = getIvSeries(F.cur, [d], d0(d) + 12 * HR, d0(d) + 24 * HR);

    if (cl.length < 500 || sN2n.length < 50) continue;

    // Determine 17:30 reference IV (listing window 17:30 - 18:00)
    const listingSamples = sN2n.filter(p => p[0] >= F.listing && p[0] <= F.listing + 45 * MIN).map(p => p[1]);
    const iv1730 = listingSamples.length ? listingSamples.sort((a, b) => a - b)[listingSamples.length >> 1] : null;

    // Scan entry window: NY open + 30m to NY open + 90m
    const entStart = F.open + 30 * MIN;
    const entEnd = F.open + 105 * MIN;

    // Find the standard entry point (either when IV turns down 1.5% off high, or default at NY open + 60m)
    let bestEntryTime = F.open + 60 * MIN;
    let nyHigh = 0;
    for (let t = F.open; t <= entEnd; t += 5 * MIN) {
      const v = at(sN2n, t);
      if (v && v > nyHigh) nyHigh = v;
      if (t >= entStart && v && nyHigh > 0) {
        const off = (nyHigh - v) / nyHigh * 100;
        if (off >= 1.5 && off <= 6.0) {
          bestEntryTime = t;
          break;
        }
      }
    }

    const t0 = bestEntryTime;
    const S0 = H.get(t0)?.[2];
    const iv0 = at(sN2n, t0);
    if (!S0 || !iv0) continue;

    // Delta 0.12-0.15 strangling
    const dC = (iv0 < 28 || F.dow === 4) ? 0.12 : 0.15;
    const T0 = yrs(F.settle - t0);
    const Kc = strike(S0, T0, iv0, dC, 'c');
    const Kp = strike(S0, T0, iv0, dC, 'p');
    const c0 = bs(S0, Kc, T0, iv0, 'c');
    const p0 = bs(S0, Kp, T0, iv0, 'p');
    const cr = c0 + p0;

    // Simulate minute-by-minute with 2x per-leg stop loss
    let stopped = false;
    let stopLeg = '';
    let cs = false;
    let ps = false;
    let exitT = F.exit; // 07:00 IST next morning
    let lastPnl = 0;

    let j = 0;
    while (j < sN2n.length && sN2n[j][0] <= t0) j++;
    let currentIv = iv0;

    for (let t = t0 + MIN; t <= exitT; t += MIN) {
      while (j < sN2n.length && sN2n[j][0] <= t) {
        currentIv = sN2n[j][1];
        j++;
      }
      const bar = H.get(t);
      if (!bar) continue;

      const T = yrs(F.settle - t);
      const ch = bs(bar[0], Kc, T, currentIv, 'c');
      const pl = bs(bar[1], Kp, T, currentIv, 'p');
      const cc = bs(bar[2], Kc, T, currentIv, 'c');
      const pcl = bs(bar[2], Kp, T, currentIv, 'p');

      if (!cs && ch >= 2 * c0) {
        cs = true;
        stopped = true;
        stopLeg = 'call';
        lastPnl = cr - 2 * c0 - pcl;
        break;
      }
      if (!ps && pl >= 2 * p0) {
        ps = true;
        stopped = true;
        stopLeg = 'put';
        lastPnl = cr - cc - 2 * p0;
        break;
      }

      lastPnl = cr - cc - pcl;
    }

    const pnlPct = (lastPnl / cr) * 100;
    const win = !stopped && pnlPct > 0;

    // Evaluate indicators at entry time t0:
    // 1. IV vs 17:30
    const ivVs1730 = iv1730 != null ? iv0 < iv1730 : null;

    // 2. Speed vs IV (Realized vol over last 60m / IV)
    const rv60 = rvOver(cl, t0, 60);
    const speedVsIv = rv60 != null && iv0 > 0 ? rv60 / iv0 : null;
    const speedUnder15 = speedVsIv != null ? speedVsIv < 1.5 : null;
    const speedUnder10 = speedVsIv != null ? speedVsIv < 1.0 : null;

    // 3. ADX 1h Trend (Wilder ADX(14) on 1-hour bars as per desk rules)
    const adxNow = getAdxAt(t0);
    const adx3h = getAdxAt(t0 - 3 * HR);
    const adx1h = getAdxAt(t0 - HR);
    const adxFalling = (adxNow != null && adx3h != null) ? (adxNow <= 40 && adxNow <= adx3h) : (adxNow != null && adx1h != null ? (adxNow <= 40 && adxNow <= adx1h) : null);

    // 4. IV Turn (% off NY high)
    const ivTurnOffPct = nyHigh > 0 ? (nyHigh - iv0) / nyHigh * 100 : null;
    const ivTurnValid = ivTurnOffPct != null ? (ivTurnOffPct >= 1.5 && ivTurnOffPct <= 6.0) : null;

    // 5. Term Spread
    const snap = getSnapshot(t0);
    const curAtT0 = at(sCur, t0);
    const termSpread = (curAtT0 != null && iv0 != null) ? (curAtT0 - iv0) : (snap?.term_current_n2n ? Number(snap.term_current_n2n) : null);
    const termBackwardation = termSpread != null ? termSpread > 0 : null;

    // 6. DB Skew & Funding
    const skew25d = snap?.skew_25d ? Number(snap.skew_25d) : null;
    const fundingRate = snap?.funding_rate ? Number(snap.funding_rate) : null;

    // Check count: roll, speed, adx
    let checksGoodCount = 0;
    if (ivVs1730 === true) checksGoodCount++;
    if (speedUnder15 === true) checksGoodCount++;
    if (adxFalling === true) checksGoodCount++;

    const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    allTrades.push({
      night: d,
      dow: F.dow,
      dowName: dowNames[F.dow],
      entryTime: t0,
      exitTime: exitT,
      spot0: S0,
      iv0,
      callStrike: Kc,
      putStrike: Kp,
      credit: cr,
      stopped,
      stopLeg,
      pnlPct,
      win,
      ivVs1730,
      iv1730Level: iv1730,
      speedVsIv,
      speedUnder15,
      speedUnder10,
      adxFalling,
      ivTurnOffPct,
      ivTurnValid,
      termBackwardation,
      termSpread,
      skew25d,
      fundingRate,
      checksGoodCount,
    });
  }

  console.log(`\nSimulation complete! Total real nights evaluated: ${allTrades.length}`);
  const totalStopped = allTrades.filter(t => t.stopped).length;
  const totalWon = allTrades.filter(t => t.win).length;
  console.log(`Overall Baseline: Won = ${totalWon} (${(totalWon / allTrades.length * 100).toFixed(1)}%), Stopped = ${totalStopped} (${(totalStopped / allTrades.length * 100).toFixed(1)}%)`);

  // --------------------------------------------------------------------------
  // Statistical Correlation & Stop-Loss Avoidance Strength Helper
  // --------------------------------------------------------------------------
  interface MetricGroup {
    name: string;
    subgroups: {
      label: string;
      filter: (t: TradeTest) => boolean;
    }[];
  }

  function calcStats(subTrades: TradeTest[]) {
    const N = subTrades.length;
    if (N === 0) return { N: 0, slCount: 0, slRate: 0, winCount: 0, winRate: 0, avgPnl: 0 };
    const slCount = subTrades.filter(t => t.stopped).length;
    const slRate = (slCount / N) * 100;
    const winCount = subTrades.filter(t => t.win).length;
    const winRate = (winCount / N) * 100;
    const avgPnl = subTrades.reduce((acc, t) => acc + t.pnlPct, 0) / N;
    return { N, slCount, slRate, winCount, winRate, avgPnl };
  }

  function correlationPointBiserial(trades: TradeTest[], testFn: (t: TradeTest) => boolean | null) {
    const valid = trades.filter(t => testFn(t) !== null);
    if (valid.length < 4) return { r: 0, chi2: 0, pVal: 1, oddsRatio: 1 };
    
    // Group 1 = Condition True, Group 0 = Condition False
    const g1 = valid.filter(t => testFn(t) === true);
    const g0 = valid.filter(t => testFn(t) === false);

    const a = g1.filter(t => t.stopped).length; // True & Stopped
    const b = g1.filter(t => !t.stopped).length; // True & Not Stopped
    const c = g0.filter(t => t.stopped).length; // False & Stopped
    const d = g0.filter(t => !t.stopped).length; // False & Not Stopped

    // Chi-Square 2x2: (N * (ad - bc)^2) / ((a+b)(c+d)(a+c)(b+d))
    const N = valid.length;
    const num = Math.pow(Math.abs(a * d - b * c), 2) * N;
    const den = (a + b) * (c + d) * (a + c) * (b + d);
    const chi2 = den > 0 ? num / den : 0;

    // Odds Ratio: (a/b) / (c/d) = (a*d) / (b*c)
    const oddsRatio = (b * c > 0) ? (a * d) / (b * c) : (a > 0 ? 99 : 1);

    // Point-biserial r: (Mean_stopped - Mean_not_stopped) / std * sqrt(p*q)
    const y = valid.map(t => t.stopped ? 1 : 0);
    const x = valid.map(t => testFn(t) ? 1 : 0);
    const meanX = x.reduce((s, v) => s + v, 0) / N;
    const meanY = y.reduce((s, v) => s + v, 0) / N;
    let cov = 0, varX = 0, varY = 0;
    for (let i = 0; i < N; i++) {
      cov += (x[i] - meanX) * (y[i] - meanY);
      varX += Math.pow(x[i] - meanX, 2);
      varY += Math.pow(y[i] - meanY, 2);
    }
    const r = (varX > 0 && varY > 0) ? cov / Math.sqrt(varX * varY) : 0;

    return { r, chi2, oddsRatio };
  }

  // --------------------------------------------------------------------------
  // Run Evaluations for Each Clock Indicator
  // --------------------------------------------------------------------------
  const indicatorsToTest: {
    name: string;
    description: string;
    testGood: (t: TradeTest) => boolean | null;
    labels: [string, string]; // [Good condition label, Bad condition label]
  }[] = [
    {
      name: 'IV vs 17:30 Level (Tonight Clock Line)',
      description: 'Is ATM IV at entry lower than its 17:30 listing level?',
      testGood: (t) => t.ivVs1730,
      labels: ['IV < 17:30 (Cooling)', 'IV >= 17:30 (Elevated / Hot)'],
    },
    {
      name: 'Speed vs IV (Realized Vol / Implied Vol Rays)',
      description: 'Is BTC movement speed calm relative to IV (< 1.5x)?',
      testGood: (t) => t.speedUnder15,
      labels: ['Speed < 1.5x (Calm)', 'Speed >= 1.5x (Agitated / Breakout)'],
    },
    {
      name: 'Strict Speed vs IV (< 1.0x)',
      description: 'Is BTC movement slower than IV pays (< 1.0x)?',
      testGood: (t) => t.speedUnder10,
      labels: ['Speed < 1.0x (Green Rays)', 'Speed >= 1.0x (Amber/Red Rays)'],
    },
    {
      name: '1-Hour ADX Trend (Clock Inner Ring)',
      description: 'Is the 1-hour trend intensity falling (ADX falling)?',
      testGood: (t) => t.adxFalling,
      labels: ['ADX Falling (Green Ring)', 'ADX Flat / Rising (Yellow/Red Ring)'],
    },
    {
      name: 'IV Turn (% off NY High)',
      description: 'Did IV turn down 1.5% to 6.0% off its NY session peak?',
      testGood: (t) => t.ivTurnValid,
      labels: ['1.5% - 6.0% Turn Confirmed', 'No Turn (<1.5%) or Late (>6.0%)'],
    },
    {
      name: 'Term Structure Spread (Cur IV - N2N IV)',
      description: 'Is term in backwardation (Current > N2N, front IV premium)?',
      testGood: (t) => t.termBackwardation,
      labels: ['Backwardation (Cur > N2N)', 'Contango (Cur <= N2N)'],
    },
    {
      name: 'Combined Clock 3-Check Rule (IV + ADX + Speed)',
      description: 'All 3 clock checks green: IV < 17:30 AND Speed < 1.5x AND ADX Falling',
      testGood: (t) => (t.checksGoodCount === 3 ? true : (t.checksGoodCount <= 1 ? false : null)),
      labels: ['All 3 Checks Good (Green Face)', '2+ Checks Bad (Red Face)'],
    },
    {
      name: 'Thursday Skip Rule (Calendar / Expiry Dynamics)',
      description: 'Thursday nights (Sunday expiry, 3-day weekend decay vs move)',
      testGood: (t) => t.dow !== 4,
      labels: ['Non-Thursday (Mon-Wed, Fri)', 'Thursday (Sunday Expiry)'],
    },
  ];

  console.log('\n' + '='.repeat(85));
  console.log('  INDIVIDUAL INDICATOR PREDICTIVE POWER RANKING (STOP-LOSS AVOIDANCE)');
  console.log('='.repeat(85));

  const resultsSummary: any[] = [];

  for (const ind of indicatorsToTest) {
    const goodTrades = allTrades.filter(t => ind.testGood(t) === true);
    const badTrades = allTrades.filter(t => ind.testGood(t) === false);
    const statGood = calcStats(goodTrades);
    const statBad = calcStats(badTrades);
    const statObj = correlationPointBiserial(allTrades, ind.testGood);

    const slAvoidanceAdvantage = statBad.slRate - statGood.slRate;
    const relativeRisk = statGood.slRate > 0 ? (statBad.slRate / statGood.slRate) : 99;

    resultsSummary.push({
      indicator: ind.name,
      goodLabel: ind.labels[0],
      goodN: statGood.N,
      goodSL: `${statGood.slCount}/${statGood.N} (${statGood.slRate.toFixed(1)}%)`,
      goodWin: `${statGood.winCount}/${statGood.N} (${statGood.winRate.toFixed(1)}%)`,
      goodPnl: `${statGood.avgPnl >= 0 ? '+' : ''}${statGood.avgPnl.toFixed(1)}%`,
      badLabel: ind.labels[1],
      badN: statBad.N,
      badSL: `${statBad.slCount}/${statBad.N} (${statBad.slRate.toFixed(1)}%)`,
      badWin: `${statBad.winCount}/${statBad.N} (${statBad.winRate.toFixed(1)}%)`,
      badPnl: `${statBad.avgPnl >= 0 ? '+' : ''}${statBad.avgPnl.toFixed(1)}%`,
      slAvoidanceDelta: `+${slAvoidanceAdvantage.toFixed(1)}% lower SL`,
      oddsRatio: statObj.oddsRatio.toFixed(2),
      rScore: statObj.r.toFixed(3),
      chi2: statObj.chi2.toFixed(2),
    });

    console.log(`\n[INDICATOR] ${ind.name}`);
    console.log(`  Definition: ${ind.description}`);
    console.log(`  ✓ WHEN GOOD [${ind.labels[0]}]:`);
    console.log(`    Sample: N = ${statGood.N} | Stop-Loss: ${statGood.slCount} (${statGood.slRate.toFixed(1)}%) | Win: ${statGood.winCount} (${statGood.winRate.toFixed(1)}%) | Avg P&L: ${statGood.avgPnl >= 0 ? '+' : ''}${statGood.avgPnl.toFixed(1)}% credit`);
    console.log(`  ✗ WHEN BAD  [${ind.labels[1]}]:`);
    console.log(`    Sample: N = ${statBad.N} | Stop-Loss: ${statBad.slCount} (${statBad.slRate.toFixed(1)}%) | Win: ${statBad.winCount} (${statBad.winRate.toFixed(1)}%) | Avg P&L: ${statBad.avgPnl >= 0 ? '+' : ''}${statBad.avgPnl.toFixed(1)}% credit`);
    console.log(`  📊 PREDICTIVE POWER:`);
    console.log(`    Stop-Loss Avoidance Spread: ${slAvoidanceAdvantage >= 0 ? '+' : ''}${slAvoidanceAdvantage.toFixed(1)}% (Bad vs Good)`);
    console.log(`    Relative Stop-Loss Risk:    ${relativeRisk.toFixed(2)}x higher failure rate when bad`);
    console.log(`    Point-Biserial r:           ${statObj.r.toFixed(3)} | Chi-Square: ${statObj.chi2.toFixed(2)}`);
  }

  // --------------------------------------------------------------------------
  // Check Count Degradation Ladder (3 Good vs 2 Good vs 1 Good vs 0 Good)
  // --------------------------------------------------------------------------
  console.log('\n' + '='.repeat(85));
  console.log('  CLOCK MULTI-INDICATOR LADDER: 3 CHECKS (IV vs 17:30 + Speed + ADX)');
  console.log('='.repeat(85));

  for (let c = 3; c >= 0; c--) {
    const subset = allTrades.filter(t => t.checksGoodCount === c);
    const s = calcStats(subset);
    console.log(`  [${c} CHECKS GOOD] N = ${s.N.toString().padStart(2, ' ')} | Stop-Loss: ${s.slCount.toString().padStart(2, ' ')} (${s.slRate.toFixed(1).padStart(5, ' ')}%) | Win: ${s.winCount.toString().padStart(2, ' ')} (${s.winRate.toFixed(1).padStart(5, ' ')}%) | Avg P&L: ${s.avgPnl >= 0 ? '+' : ''}${s.avgPnl.toFixed(1)}% credit`);
  }

  // --------------------------------------------------------------------------
  // Day of Week Breakdown
  // --------------------------------------------------------------------------
  console.log('\n' + '='.repeat(85));
  console.log('  DAY OF WEEK STOP-LOSS BREAKDOWN');
  console.log('='.repeat(85));
  for (const dow of [1, 2, 3, 4, 5]) {
    const subset = allTrades.filter(t => t.dow === dow);
    const s = calcStats(subset);
    const name = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
    console.log(`  ${name.padEnd(5, ' ')}: N = ${s.N.toString().padStart(2, ' ')} | Stop-Loss: ${s.slCount.toString().padStart(2, ' ')} (${s.slRate.toFixed(1).padStart(5, ' ')}%) | Win: ${s.winCount.toString().padStart(2, ' ')} (${s.winRate.toFixed(1).padStart(5, ' ')}%) | Avg P&L: ${s.avgPnl >= 0 ? '+' : ''}${s.avgPnl.toFixed(1)}% credit`);
  }

  // Cross-reference with user's historical 1-year archive constants
  console.log('\n' + '='.repeat(85));
  console.log('  HISTORICAL 1-YEAR BENCHMARK RECONCILIATION (From v126/v142/v147 stores)');
  console.log('='.repeat(85));
  console.log('  1. v142_pwin 1-Year Prior Test (N = 163 nights):');
  console.log('     Baseline Win Rate: 61.0% | Stop-Loss Rate: 39.0%');
  console.log('     ADX Falling:       Win 59.0% vs 53.0% without (+6.0% win advantage)');
  console.log('     Speed Falling:     Win 57.0% vs 53.0% without (+4.0% win advantage)');
  console.log('  2. 1-Year Day of Week Stop Rates (CELL / COACH 249 nights):');
  console.log('     Thursday: 83.0% Stopped (-15.2% desk P&L) -> Absolute worst day');
  console.log('     Monday (IV < 35): 50.0% Stopped');
  console.log('     Monday (IV >= 35): 12.0% Stopped');
  console.log('     Friday: 49.0% Stopped (93% IV fell, +21.0% desk credit)');
  console.log('='.repeat(85));
}

main()
  .catch(console.error)
  .finally(async () => {
    await pool.end();
  });
