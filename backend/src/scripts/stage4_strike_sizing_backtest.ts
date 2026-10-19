import fs from 'node:fs';

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
  const raw = S * Math.exp(-(d1 * s * Math.sqrt(T) - 0.5 * s * s * T));
  const grid = S > 50000 ? 500 : 250;
  return cp === 'c' ? Math.ceil(raw / grid) * grid : Math.floor(raw / grid) * grid;
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
    exit: D0 + 31 * HR,
    cur: keyOf(base + 1),
    nxt: keyOf(base + 2),
    n2n: keyOf(base + 3),
    settle: (base + 3) * DAY - IST + 17.5 * HR,
    listing: D0 + 17.5 * HR,
    dow: new Date(base * DAY).getUTCDay(),
  };
}

function calcChi2Yates(a: number, b: number, c: number, d: number) {
  const N = a + b + c + d;
  const num = Math.pow(Math.max(0, Math.abs(a * d - b * c) - N / 2), 2) * N;
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  const chi2 = den > 0 ? num / den : 0;
  const z = Math.sqrt(chi2);
  const tZ = 1 / (1 + 0.2316419 * z);
  const pVal = 2 * (0.3989423 * Math.exp(-chi2 / 2)) * tZ * (0.3193815 + tZ * (-0.3565638 + tZ * (1.781478 + tZ * (-1.821256 + tZ * 1.330274))));
  return { chi2, pVal, N };
}

async function main() {
  console.log('='.repeat(90));
  console.log('  STAGE 4 BACKTEST: STRIKE SELECTION & DYNAMIC WIDENING RULES');
  console.log('  Comparing Fixed Deltas (0.10Δ to 0.20Δ) vs Dynamic Desk Widening Models');
  console.log('  Full Rigor: Bonferroni Correction & 50/50 Walk-Forward Out-of-Sample');
  console.log('='.repeat(90));

  const dexCandles: any[] = JSON.parse(fs.readFileSync('dexbtusd_1year.json', 'utf-8'));
  const btcMap = new Map<number, { t: number; o: number; h: number; l: number; c: number }>();
  for (const c of dexCandles) {
    const ms = c.time * 1000;
    btcMap.set(ms, { t: ms, o: c.open, h: c.high, l: c.low, c: c.close });
  }

  function getRv(endT: number, hours: number): number | null {
    const endH = Math.floor(endT / HR) * HR;
    const rets: number[] = [];
    for (let i = 0; i < hours; i++) {
      const b1 = btcMap.get(endH - i * HR);
      const b0 = btcMap.get(endH - (i + 1) * HR);
      if (b1 && b0 && b1.c > 0 && b0.c > 0) rets.push(Math.log(b1.c / b0.c));
    }
    if (rets.length < hours * 0.6) return null;
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const s2 = rets.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (rets.length - 1);
    return Math.sqrt(s2 * 8760) * 100;
  }

  const exportRaw = fs.readFileSync('browser-data-export.json', 'utf-8');
  const bundle = JSON.parse(exportRaw);
  const ivStore = bundle.indexedDB?.suraj_archive_v1?.stores?.iv || [];
  const ivDataMap = new Map<string, any>();
  for (const item of ivStore) {
    const v = item.value || item;
    if (v.e && v.day && v.c) ivDataMap.set(`${v.e}|${v.day}`, v.c);
  }

  function getIvAt(expiry: string, day: string, ms: number): number | null {
    const cObj = ivDataMap.get(`${expiry}|${day}`);
    if (!cObj) return null;
    const dayStart = d0(day);
    const minute = Math.floor((ms - dayStart) / MIN);
    if (minute < 0 || minute >= 1440) return null;
    const val = cObj[minute];
    if (Number.isFinite(val) && val > 0) return val < 5 ? val * 100 : val;
    for (let d = 1; d <= 25; d++) {
      for (const sign of [-1, 1]) {
        const m2 = minute + d * sign;
        if (m2 >= 0 && m2 < 1440) {
          const v2 = cObj[m2];
          if (Number.isFinite(v2) && v2 > 0) return v2 < 5 ? v2 * 100 : v2;
        }
      }
    }
    return null;
  }

  const dateSet = new Set<string>();
  for (const item of ivStore) {
    const v = item.value || item;
    if (v.day && v.day >= '2025-10-06' && v.day <= '2026-10-18') dateSet.add(v.day);
  }
  const sortedDays = [...dateSet].sort();

  // Define Strike Selection Models
  interface StrikeModel {
    id: string;
    name: string;
    cat: 'Fixed Delta' | 'Dynamic Widening';
    getDeltas: (F: any, iv0: number, S0: number, bNoon: any) => { deltaC: number; deltaP: number };
  }

  const strikeModels: StrikeModel[] = [
    {
      id: 'fixed_10',
      name: 'Fixed 0.10Δ Wings (Ultra-Wide Conservative)',
      cat: 'Fixed Delta',
      getDeltas: () => ({ deltaC: 0.10, deltaP: 0.10 }),
    },
    {
      id: 'fixed_12',
      name: 'Fixed 0.12Δ Wings (Wide Defensive)',
      cat: 'Fixed Delta',
      getDeltas: () => ({ deltaC: 0.12, deltaP: 0.12 }),
    },
    {
      id: 'fixed_15_baseline',
      name: 'Fixed 0.15Δ Wings (Standard Baseline)',
      cat: 'Fixed Delta',
      getDeltas: () => ({ deltaC: 0.15, deltaP: 0.15 }),
    },
    {
      id: 'fixed_18',
      name: 'Fixed 0.18Δ Wings (Aggressive Theta)',
      cat: 'Fixed Delta',
      getDeltas: () => ({ deltaC: 0.18, deltaP: 0.18 }),
    },
    {
      id: 'fixed_20',
      name: 'Fixed 0.20Δ Wings (Ultra-Tight Premium Grab)',
      cat: 'Fixed Delta',
      getDeltas: () => ({ deltaC: 0.20, deltaP: 0.20 }),
    },
    {
      id: 'dynamic_friday_only',
      name: 'Friday Widening Only (0.11Δ Fri, 0.15Δ rest)',
      cat: 'Dynamic Widening',
      getDeltas: (F) => ({
        deltaC: F.dow === 5 ? 0.11 : 0.15,
        deltaP: F.dow === 5 ? 0.11 : 0.15,
      }),
    },
    {
      id: 'dynamic_low_iv_only',
      name: 'Low IV Widening Only (0.12Δ if IV < 28, else 0.15Δ)',
      cat: 'Dynamic Widening',
      getDeltas: (F, iv0) => ({
        deltaC: iv0 < 28 ? 0.12 : 0.15,
        deltaP: iv0 < 28 ? 0.12 : 0.15,
      }),
    },
    {
      id: 'dynamic_put_tilt_only',
      name: 'Put Leg Tilt Only (0.12Δ Put if spot dropped since noon)',
      cat: 'Dynamic Widening',
      getDeltas: (F, iv0, S0, bNoon) => ({
        deltaC: 0.15,
        deltaP: (bNoon && S0 < bNoon.c) ? 0.12 : 0.15,
      }),
    },
    {
      id: 'dynamic_authentic_desk',
      name: 'Full Authentic Desk Model (Fri 0.11Δ + LowIV 0.12Δ + Put Tilt)',
      cat: 'Dynamic Widening',
      getDeltas: (F, iv0, S0, bNoon) => {
        let dc = 0.15, dp = 0.15;
        if (F.dow === 5) { dc = 0.11; dp = 0.11; }
        else if (F.dow === 4 || iv0 < 28) { dc = 0.12; dp = 0.12; }
        if (bNoon && S0 < bNoon.c) { dp = Math.min(dp, 0.12); }
        return { deltaC: dc, deltaP: dp };
      },
    },
    {
      id: 'dynamic_super_defensive',
      name: 'Super Defensive Desk (0.10Δ Fri, 0.12Δ other days, 0.10Δ Put tilt)',
      cat: 'Dynamic Widening',
      getDeltas: (F, iv0, S0, bNoon) => {
        let dc = 0.12, dp = 0.12;
        if (F.dow === 5) { dc = 0.10; dp = 0.10; }
        if (bNoon && S0 < bNoon.c) { dp = 0.10; }
        return { deltaC: dc, deltaP: dp };
      },
    },
  ];

  interface StrikeRunRecord {
    day: string;
    dow: number;
    stopped: boolean;
    win: boolean;
    pnlPct: number;
    pnlDollars: number;
    credit: number;
    deltaC: number;
    deltaP: number;
    callStop: boolean;
    putStop: boolean;
  }

  const modelResults = new Map<string, StrikeRunRecord[]>();
  for (const m of strikeModels) modelResults.set(m.id, []);

  for (let i = 0; i < sortedDays.length; i++) {
    const d = sortedDays[i];
    const nextDayStr = sortedDays[i + 1] || dk(Date.parse(d + 'T12:00:00Z') + DAY);
    const F = frame(d0(d) + 20 * HR);
    if (F.dow === 0 || F.dow === 6) continue;

    // Use standard authentic entry (60m post-open)
    const entryH = Math.floor((F.open + 60 * MIN) / HR) * HR;
    const b0 = btcMap.get(entryH) || btcMap.get(entryH - HR);
    if (!b0 || b0.c <= 0) continue;

    const S0 = b0.c;
    const t0 = entryH;

    let iv0 = getIvAt(F.n2n, d, t0) || getIvAt(F.cur, d, t0);
    if (!iv0 || iv0 < 10 || iv0 > 150) continue;

    const noonT = Math.floor((F.D0 + 13 * HR) / HR) * HR;
    const bNoon = btcMap.get(noonT);
    const T0 = yrs(F.settle - t0);
    const exitH = Math.floor(F.exit / HR) * HR;

    for (const model of strikeModels) {
      const { deltaC, deltaP } = model.getDeltas(F, iv0, S0, bNoon);

      const Kc = strike(S0, T0, iv0, deltaC, 'c');
      const Kp = strike(S0, T0, iv0, deltaP, 'p');
      const c0 = bs(S0, Kc, T0, iv0, 'c');
      const p0 = bs(S0, Kp, T0, iv0, 'p');
      const cr = c0 + p0;

      let stopped = false;
      let callStop = false;
      let putStop = false;
      let finalClose = S0;

      for (let t = t0 + HR; t <= exitH; t += HR) {
        const b = btcMap.get(t);
        if (!b) continue;
        finalClose = b.c;

        const dayForT = t < d0(nextDayStr) ? d : nextDayStr;
        let liveIv = getIvAt(F.n2n, dayForT, t) || getIvAt(F.cur, dayForT, t);
        if (!liveIv) {
          const elapsed = (t - t0) / (exitH - t0);
          liveIv = iv0 * (1 - 0.06 * elapsed);
        }
        const remT = yrs(F.settle - t);

        const cMark = bs(b.c, Kc, remT, liveIv, 'c');
        const pMark = bs(b.c, Kp, remT, liveIv, 'p');
        const callBreach = bs(b.h, Kc, remT, liveIv, 'c') >= 2.0 * c0;
        const putBreach = bs(b.l, Kp, remT, liveIv, 'p') >= 2.0 * p0;

        if (cMark >= 2.0 * c0 || callBreach) {
          stopped = true;
          callStop = true;
          break;
        }
        if (pMark >= 2.0 * p0 || putBreach) {
          stopped = true;
          putStop = true;
          break;
        }
      }

      const remT = yrs(F.settle - exitH);
      const exitIv = getIvAt(F.n2n, nextDayStr, exitH) || iv0 * 0.94;
      const cFinal = bs(finalClose, Kc, remT, exitIv, 'c');
      const pFinal = bs(finalClose, Kp, remT, exitIv, 'p');
      const pnlPct = stopped ? -100 : ((cr - cFinal - pFinal) / cr) * 100;
      const pnlDollars = stopped ? -cr : (cr - cFinal - pFinal);
      const win = !stopped && pnlPct > 0;

      modelResults.get(model.id)!.push({
        day: d,
        dow: F.dow,
        stopped,
        win,
        pnlPct,
        pnlDollars,
        credit: cr,
        deltaC,
        deltaP,
        callStop,
        putStop,
      });
    }
  }

  // Baseline metrics (fixed 0.15 delta)
  const baseline = modelResults.get('fixed_15_baseline')!;
  const baseStopped = baseline.filter(r => r.stopped).length;

  interface StrikeSummary {
    id: string;
    name: string;
    cat: string;
    sample: number;
    stoppedCount: number;
    winCount: number;
    stopRate: number;
    winRate: number;
    avgCredit: number;
    avgPnlPct: number;
    avgDollars: number;
    totalDollars: number;
    profitFactor: number;
    chi2VsBase: number;
    pValVsBase: number;
  }

  const summaries: StrikeSummary[] = [];

  for (const model of strikeModels) {
    const list = modelResults.get(model.id)!;
    const N = list.length;
    const stp = list.filter(r => r.stopped).length;
    const win = list.filter(r => r.win).length;
    const stopRate = (stp / N) * 100;
    const winRate = (win / N) * 100;
    const avgCredit = list.reduce((s, r) => s + r.credit, 0) / N;
    const avgPnlPct = list.reduce((s, r) => s + r.pnlPct, 0) / N;
    const avgDollars = list.reduce((s, r) => s + r.pnlDollars, 0) / N;
    const totalDollars = list.reduce((s, r) => s + r.pnlDollars, 0);

    const grossWins = list.filter(r => r.pnlDollars > 0).reduce((s, r) => s + r.pnlDollars, 0);
    const grossLosses = Math.abs(list.filter(r => r.pnlDollars < 0).reduce((s, r) => s + r.pnlDollars, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins;

    const chi = calcChi2Yates(stp, N - stp, baseStopped, baseline.length - baseStopped);

    summaries.push({
      id: model.id,
      name: model.name,
      cat: model.cat,
      sample: N,
      stoppedCount: stp,
      winCount: win,
      stopRate,
      winRate,
      avgCredit,
      avgPnlPct,
      avgDollars,
      totalDollars,
      profitFactor,
      chi2VsBase: chi.chi2,
      pValVsBase: chi.pVal,
    });
  }

  // Sort by Total Dollars descending
  summaries.sort((a, b) => b.totalDollars - a.totalDollars);

  console.log('\n================================================================================');
  console.log('  STAGE 4: STRIKE SELECTION RANKING (Ranked by Total Net Profit $)');
  console.log('================================================================================\n');

  console.log('| Rank | Strike Selection Model | Category | Sample | Stop Rate | Win Rate | Avg Credit ($) | Avg PnL (% credit) | Total Net Profit ($) | vs. Baseline (0.15Δ) |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  summaries.forEach((s, idx) => {
    const isBase = s.id === 'fixed_15_baseline';
    const diff = s.totalDollars - baseline.reduce((sum, r) => sum + r.pnlDollars, 0);
    const diffStr = isBase ? 'BASELINE' : (diff > 0 ? `+$${diff.toFixed(0)}` : `-$${Math.abs(diff).toFixed(0)}`);
    console.log(`| #${idx + 1} | ${s.name.padEnd(52, ' ')} | ${s.cat.padEnd(16, ' ')} | ${s.sample.toString().padEnd(6, ' ')} | ${s.stopRate.toFixed(1)}% (${s.stoppedCount}/${s.sample}) | ${s.winRate.toFixed(1)}% | $${s.avgCredit.toFixed(0)} | ${s.avgPnlPct > 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}% | ${s.totalDollars > 0 ? '+' : ''}$${s.totalDollars.toFixed(0)} | ${diffStr} |`);
  });

  // --------------------------------------------------------------------------
  // BONFERRONI AUDIT (M = 9 alternatives)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  BONFERRONI AUDIT: DOES ANY MODEL SIGNIFICANTLY BEAT FIXED 0.15Δ BASELINE?');
  console.log('================================================================================');
  const mStrike = strikeModels.length - 1;
  const alphaBonfStrike = 0.05 / mStrike;
  console.log(`Number of alternatives compared against baseline (M): ${mStrike}`);
  console.log(`Standard Alpha:   alpha = 0.0500  (Chi-Square >= 3.841)`);
  console.log(`Bonferroni Alpha: alpha = ${alphaBonfStrike.toFixed(5)} (Chi-Square >= 7.98)`);

  for (const s of summaries) {
    if (s.id === 'fixed_15_baseline') continue;
    const clearsBonf = s.pValVsBase < alphaBonfStrike;
    console.log(`  ${s.name.padEnd(54, ' ')}: Stop = ${s.stopRate.toFixed(1)}% | Chi2 = ${s.chi2VsBase.toFixed(3)} | p = ${s.pValVsBase.toFixed(4)} | Clears Bonf?: ${clearsBonf ? '>>> YES <<<' : 'NO'}`);
  }

  // --------------------------------------------------------------------------
  // PART 2: THE FRIDAY WIDENING AUDIT
  // (Testing 0.11Δ vs 0.15Δ exclusively on Friday sessions)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  FRIDAY STRIKE WIDENING AUDIT (Friday Sessions Only, N = 53)');
  console.log('================================================================================\n');

  const friFixed15 = modelResults.get('fixed_15_baseline')!.filter(r => r.dow === 5);
  const friDesk11 = modelResults.get('dynamic_authentic_desk')!.filter(r => r.dow === 5);
  const friWide10 = modelResults.get('fixed_10')!.filter(r => r.dow === 5);

  const f15Stp = friFixed15.filter(r => r.stopped).length;
  const f11Stp = friDesk11.filter(r => r.stopped).length;
  const f10Stp = friWide10.filter(r => r.stopped).length;

  console.log(`  Friday Fixed 0.15Δ Wings: Stop Rate = ${(f15Stp / friFixed15.length * 100).toFixed(1)}% (${f15Stp}/${friFixed15.length}) | Total Net = $${friFixed15.reduce((s, r) => s + r.pnlDollars, 0).toFixed(0)}`);
  console.log(`  Friday Desk 0.11Δ Wings : Stop Rate = ${(f11Stp / friDesk11.length * 100).toFixed(1)}% (${f11Stp}/${friDesk11.length}) | Total Net = $${friDesk11.reduce((s, r) => s + r.pnlDollars, 0).toFixed(0)}`);
  console.log(`  Friday Wide 0.10Δ Wings : Stop Rate = ${(f10Stp / friWide10.length * 100).toFixed(1)}% (${f10Stp}/${friWide10.length}) | Total Net = $${friWide10.reduce((s, r) => s + r.pnlDollars, 0).toFixed(0)}`);

  const chiFri = calcChi2Yates(f11Stp, friDesk11.length - f11Stp, f15Stp, friFixed15.length - f15Stp);
  console.log(`  Friday Stop Reduction:  +${(f15Stp / friFixed15.length * 100 - f11Stp / friDesk11.length * 100).toFixed(1)}% lower stop rate with 0.11Δ`);
  console.log(`  Chi-Square (Friday):    ${chiFri.chi2.toFixed(3)} (p = ${chiFri.pVal.toFixed(4)})`);

  // --------------------------------------------------------------------------
  // PART 3: PUT-LEG TILT AUDIT
  // (Testing Put-tilt when BTC spot drops from noon to entry)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  PUT-LEG TILT AUDIT (Sessions where spot fell noon to entry)');
  console.log('================================================================================\n');

  const tiltSessionsFixed = modelResults.get('fixed_15_baseline')!.filter(r => {
    const F = frame(d0(r.day) + 20 * HR);
    const noonT = Math.floor((F.D0 + 13 * HR) / HR) * HR;
    const bNoon = btcMap.get(noonT);
    const openH = Math.floor((F.open + 60 * MIN) / HR) * HR;
    const b0 = btcMap.get(openH);
    return bNoon && b0 && b0.c < bNoon.c;
  });

  const tiltSessionsTilted = modelResults.get('dynamic_put_tilt_only')!.filter(r => {
    const F = frame(d0(r.day) + 20 * HR);
    const noonT = Math.floor((F.D0 + 13 * HR) / HR) * HR;
    const bNoon = btcMap.get(noonT);
    const openH = Math.floor((F.open + 60 * MIN) / HR) * HR;
    const b0 = btcMap.get(openH);
    return bNoon && b0 && b0.c < bNoon.c;
  });

  const putBreachFixed = tiltSessionsFixed.filter(r => r.putStop).length;
  const putBreachTilted = tiltSessionsTilted.filter(r => r.putStop).length;

  console.log(`  Sessions with Pre-Market Spot Drop: N = ${tiltSessionsFixed.length}`);
  console.log(`  Without Put Tilt (Fixed 0.15Δ): Put-Leg Stops = ${(putBreachFixed / tiltSessionsFixed.length * 100).toFixed(1)}% (${putBreachFixed}/${tiltSessionsFixed.length})`);
  console.log(`  With Put Tilt (Widened to 0.12Δ): Put-Leg Stops = ${(putBreachTilted / tiltSessionsTilted.length * 100).toFixed(1)}% (${putBreachTilted}/${tiltSessionsTilted.length})`);
  const chiTilt = calcChi2Yates(putBreachTilted, tiltSessionsTilted.length - putBreachTilted, putBreachFixed, tiltSessionsFixed.length - putBreachFixed);
  console.log(`  Put Stop Reduction:             +${(putBreachFixed / tiltSessionsFixed.length * 100 - putBreachTilted / tiltSessionsTilted.length * 100).toFixed(1)}% lower put breaches`);
  console.log(`  Chi-Square (Put Tilt):          ${chiTilt.chi2.toFixed(3)} (p = ${chiTilt.pVal.toFixed(4)})`);

  // --------------------------------------------------------------------------
  // PART 4: OUT-OF-SAMPLE WALK-FORWARD VALIDATION (50/50 Split)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  OUT-OF-SAMPLE WALK-FORWARD VALIDATION (50/50 Split)');
  console.log('================================================================================');

  for (const s of summaries.slice(0, 5)) {
    const list = modelResults.get(s.id)!;
    const inSamp = list.slice(0, Math.floor(list.length / 2));
    const outSamp = list.slice(Math.floor(list.length / 2));

    const isStp = inSamp.filter(r => r.stopped).length;
    const isRate = (isStp / inSamp.length) * 100;
    const isDollars = inSamp.reduce((sum, r) => sum + r.pnlDollars, 0);

    const oosStp = outSamp.filter(r => r.stopped).length;
    const oosRate = (oosStp / outSamp.length) * 100;
    const oosDollars = outSamp.reduce((sum, r) => sum + r.pnlDollars, 0);

    console.log(`\n[MODEL]: ${s.name}`);
    console.log(`  In-Sample (H1):     Stop Rate = ${isRate.toFixed(1)}% (${isStp}/${inSamp.length}) | Net Profit = ${isDollars > 0 ? '+' : ''}$${isDollars.toFixed(0)}`);
    console.log(`  Out-of-Sample (H2): Stop Rate = ${oosRate.toFixed(1)}% (${oosStp}/${outSamp.length}) | Net Profit = ${oosDollars > 0 ? '+' : ''}$${oosDollars.toFixed(0)}`);
    console.log(`  Stability:          ${Math.abs(isRate - oosRate) < 10 ? 'STABLE' : 'DRIFT'}`);
  }

  // --------------------------------------------------------------------------
  // PART 5: POSITION SIZING BACKTEST (Full / Half / Skip Rules)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  PART 5: POSITION SIZING RULES (Sharpe Ratio, Profit Factor, Drawdown)');
  console.log('================================================================================\n');

  interface SizingRule {
    name: string;
    getSize: (r: StrikeRunRecord, F: any, rv6: number | null, iv0: number) => number;
  }

  const sizingRules: SizingRule[] = [
    {
      name: 'Fixed 1.0x Size Every Night (No Sizing Rule)',
      getSize: () => 1.0,
    },
    {
      name: 'Calendar Sizing (1.0x Tue/Wed, 0.5x Mon/Fri, Skip Thu)',
      getSize: (r) => {
        if (r.dow === 4) return 0.0;
        if (r.dow === 2 || r.dow === 3) return 1.0;
        return 0.5;
      },
    },
    {
      name: 'Speed Sizing (1.0x Speed < 1.0, 0.5x Speed 1.0-1.5, Skip >= 1.5)',
      getSize: (r, F, rv6, iv0) => {
        if (!rv6 || iv0 <= 0) return 0.5;
        const spd = rv6 / iv0;
        if (spd >= 1.5) return 0.0;
        if (spd < 1.0) return 1.0;
        return 0.5;
      },
    },
    {
      name: 'Combined Master Sizing (1.0x Tue/Wed Calm, 0.5x Mon/Fri Calm, Skip rest)',
      getSize: (r, F, rv6, iv0) => {
        if (r.dow === 4) return 0.0; // Skip Thursday
        if (!rv6 || iv0 <= 0) return 0.0;
        const spd = rv6 / iv0;
        if (spd >= 1.5) return 0.0; // Skip high speed
        if (r.dow === 2 || r.dow === 3) return 1.0; // Full size Tue/Wed
        return 0.5; // Half size Mon/Fri
      },
    },
  ];

  const deskTrades = modelResults.get('dynamic_authentic_desk')!;

  console.log('| Sizing Rule | Active Trades | Win Rate | Net Profit ($) | Profit Factor | Max Drawdown ($) | Sharpe Ratio |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const sRule of sizingRules) {
    let equity = 0;
    let peakEquity = 0;
    let maxDd = 0;
    let grossWins = 0;
    let grossLosses = 0;
    let activeTrades = 0;
    let winCount = 0;
    const rets: number[] = [];

    for (let i = 0; i < deskTrades.length; i++) {
      const tr = deskTrades[i];
      const F = frame(d0(tr.day) + 20 * HR);
      const entryH = Math.floor((F.open + 60 * MIN) / HR) * HR;
      const rv6 = getRv(entryH, 6);
      const iv0 = getIvAt(F.n2n, tr.day, entryH) || getIvAt(F.cur, tr.day, entryH) || 30;

      const size = sRule.getSize(tr, F, rv6, iv0);
      if (size <= 0) continue;

      activeTrades++;
      const pnl = tr.pnlDollars * size;
      equity += pnl;
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity - equity;
      if (dd > maxDd) maxDd = dd;

      if (pnl > 0) {
        grossWins += pnl;
        winCount++;
      } else {
        grossLosses += Math.abs(pnl);
      }
      rets.push(pnl);
    }

    const winRate = activeTrades > 0 ? (winCount / activeTrades) * 100 : 0;
    const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins;
    const meanRet = rets.length > 0 ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const variance = rets.length > 1 ? rets.reduce((a, b) => a + Math.pow(b - meanRet, 2), 0) / (rets.length - 1) : 0;
    const stdRet = Math.sqrt(variance);
    const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;

    console.log(`| ${sRule.name.padEnd(52, ' ')} | ${activeTrades.toString().padEnd(13, ' ')} | ${winRate.toFixed(1)}% | ${equity > 0 ? '+' : ''}$${equity.toFixed(0).padEnd(13, ' ')} | ${pf.toFixed(2)}x          | -$${maxDd.toFixed(0).padEnd(15, ' ')} | ${sharpe.toFixed(2)} |`);
  }

  // --------------------------------------------------------------------------
  // PART 6: 50/50 WALK-FORWARD OUT-OF-SAMPLE SPLIT FOR POSITION SIZING
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  PART 6: 50/50 OUT-OF-SAMPLE WALK-FORWARD VALIDATION FOR POSITION SIZING');
  console.log('================================================================================\n');

  console.log('| Sizing Rule | In-Sample (H1) Stop | In-Sample Win | In-Sample Net ($) | Out-of-Sample (H2) Stop | Out-of-Sample Win | Out-of-Sample Net ($) | Stability Verdict |');
  console.log('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  const halfIdx = Math.floor(deskTrades.length / 2);
  const inTrades = deskTrades.slice(0, halfIdx);
  const outTrades = deskTrades.slice(halfIdx);

  function evalSizingHalf(trades: StrikeRunRecord[], sRule: SizingRule) {
    let pnlTotal = 0;
    let stops = 0;
    let wins = 0;
    let total = 0;

    for (let i = 0; i < trades.length; i++) {
      const tr = trades[i];
      const F = frame(d0(tr.day) + 20 * HR);
      const entryH = Math.floor((F.open + 60 * MIN) / HR) * HR;
      const rv6 = getRv(entryH, 6);
      const iv0 = getIvAt(F.n2n, tr.day, entryH) || getIvAt(F.cur, tr.day, entryH) || 30;

      const size = sRule.getSize(tr, F, rv6, iv0);
      if (size <= 0) continue;

      total++;
      pnlTotal += tr.pnlDollars * size;
      if (tr.stopped) stops++;
      else if (tr.win) wins++;
    }

    const stopRate = total > 0 ? (stops / total) * 100 : 0;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    return { total, stops, wins, stopRate, winRate, pnlTotal };
  }

  for (const sRule of sizingRules.slice(1)) {
    const is = evalSizingHalf(inTrades, sRule);
    const oos = evalSizingHalf(outTrades, sRule);
    const stopDiff = Math.abs(is.stopRate - oos.stopRate);
    const verdict = stopDiff < 15 ? 'STABLE' : 'DRIFT';

    console.log(`| ${sRule.name.padEnd(45, ' ')} | ${is.stopRate.toFixed(1)}% (${is.stops}/${is.total}) | ${is.winRate.toFixed(1)}% | ${is.pnlTotal > 0 ? '+' : ''}$${is.pnlTotal.toFixed(0).padEnd(8, ' ')} | ${oos.stopRate.toFixed(1)}% (${oos.stops}/${oos.total}) | ${oos.winRate.toFixed(1)}% | ${oos.pnlTotal > 0 ? '+' : ''}$${oos.pnlTotal.toFixed(0).padEnd(8, ' ')} | ${verdict.padEnd(17, ' ')} |`);
  }
}

main().catch(console.error);
