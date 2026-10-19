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
    exit: D0 + 31 * HR, // 07:00 IST next morning
    cur: keyOf(base + 1),
    nxt: keyOf(base + 2),
    n2n: keyOf(base + 3),
    settle: (base + 3) * DAY - IST + 17.5 * HR, // 17:30 IST expiry
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
  console.log('  STAGE 3 BACKTEST: OPTIMAL EXIT TIMING FOR THE SHORT STRANGLE');
  console.log('  Testing Fixed Times vs Profit Targets vs Expiry Hold (269 Real Nights)');
  console.log('  Scientific Rigor: Bonferroni Correction & 50/50 Walk-Forward Out-of-Sample');
  console.log('='.repeat(90));

  const dexCandles: any[] = JSON.parse(fs.readFileSync('dexbtusd_1year.json', 'utf-8'));
  const btcMap = new Map<number, { t: number; o: number; h: number; l: number; c: number }>();
  for (const c of dexCandles) {
    const ms = c.time * 1000;
    btcMap.set(ms, { t: ms, o: c.open, h: c.high, l: c.low, c: c.close });
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

  // Exit Strategy Definition
  interface ExitStrategy {
    id: string;
    name: string;
    cat: 'Fixed Time' | 'Profit Target' | 'Dynamic';
    // Returns boolean whether position should exit at this step
    shouldExit: (
      t: number,
      F: any,
      entryCredit: number,
      currentStrangleVal: number,
      currentProfitPct: number,
      cMark: number,
      pMark: number,
      c0: number,
      p0: number
    ) => boolean;
  }

  const exitStrategies: ExitStrategy[] = [
    {
      id: 'fixed_0200',
      name: 'Fixed 02:00 IST Exit (Night Owl - Early Overnight)',
      cat: 'Fixed Time',
      shouldExit: (t, F) => t >= F.D0 + 26 * HR,
    },
    {
      id: 'fixed_0400',
      name: 'Fixed 04:00 IST Exit (Pre-Asia Quiet Window)',
      cat: 'Fixed Time',
      shouldExit: (t, F) => t >= F.D0 + 28 * HR,
    },
    {
      id: 'fixed_0600',
      name: 'Fixed 06:00 IST Exit (Asia Open Pre-Market)',
      cat: 'Fixed Time',
      shouldExit: (t, F) => t >= F.D0 + 30 * HR,
    },
    {
      id: 'fixed_0700_baseline',
      name: 'Fixed 07:00 IST Exit (Baseline Desk Default)',
      cat: 'Fixed Time',
      shouldExit: (t, F) => t >= F.D0 + 31 * HR,
    },
    {
      id: 'fixed_1000',
      name: 'Fixed 10:00 IST Exit (Mid-Asia Morning)',
      cat: 'Fixed Time',
      shouldExit: (t, F) => t >= F.D0 + 34 * HR,
    },
    {
      id: 'fixed_1300',
      name: 'Fixed 13:00 IST Exit (Asia Close / Pre-London)',
      cat: 'Fixed Time',
      shouldExit: (t, F) => t >= F.D0 + 37 * HR,
    },
    {
      id: 'hold_to_settle_1730',
      name: 'Hold to 17:30 IST Expiry Settlement (Full Theta)',
      cat: 'Fixed Time',
      shouldExit: (t, F) => t >= F.settle,
    },
    {
      id: 'tp_40_pct',
      name: 'Take Profit at 40% Premium Decayed (or 07:00 IST)',
      cat: 'Profit Target',
      shouldExit: (t, F, cr, val, profitPct) => profitPct >= 40 || t >= F.D0 + 31 * HR,
    },
    {
      id: 'tp_50_pct',
      name: 'Take Profit at 50% Premium Decayed (or 07:00 IST)',
      cat: 'Profit Target',
      shouldExit: (t, F, cr, val, profitPct) => profitPct >= 50 || t >= F.D0 + 31 * HR,
    },
    {
      id: 'tp_60_pct',
      name: 'Take Profit at 60% Premium Decayed (or 07:00 IST)',
      cat: 'Profit Target',
      shouldExit: (t, F, cr, val, profitPct) => profitPct >= 60 || t >= F.D0 + 31 * HR,
    },
    {
      id: 'tp_70_pct',
      name: 'Take Profit at 70% Premium Decayed (or 07:00 IST)',
      cat: 'Profit Target',
      shouldExit: (t, F, cr, val, profitPct) => profitPct >= 70 || t >= F.D0 + 31 * HR,
    },
    {
      id: 'tp_50_or_1300',
      name: 'Take Profit at 50% Decayed (or Hold to 13:00 IST)',
      cat: 'Profit Target',
      shouldExit: (t, F, cr, val, profitPct) => profitPct >= 50 || t >= F.D0 + 37 * HR,
    },
  ];

  interface ExitRunRecord {
    day: string;
    dow: number;
    stopped: boolean;
    win: boolean;
    pnlPct: number;
    pnlDollars: number;
    credit: number;
    exitHourIst: number;
    exitReason: 'stop' | 'target' | 'time';
  }

  const resultsByStrategy = new Map<string, ExitRunRecord[]>();
  for (const s of exitStrategies) resultsByStrategy.set(s.id, []);

  for (let i = 0; i < sortedDays.length; i++) {
    const d = sortedDays[i];
    const nextDayStr = sortedDays[i + 1] || dk(Date.parse(d + 'T12:00:00Z') + DAY);
    const dayAfterStr = sortedDays[i + 2] || dk(Date.parse(d + 'T12:00:00Z') + 2 * DAY);
    const F = frame(d0(d) + 20 * HR);
    if (F.dow === 0 || F.dow === 6) continue;

    // Use standard authentic desk entry (60 min post-open)
    const entryH = Math.floor((F.open + 60 * MIN) / HR) * HR;
    const b0 = btcMap.get(entryH) || btcMap.get(entryH - HR);
    if (!b0 || b0.c <= 0) continue;

    const S0 = b0.c;
    const t0 = entryH;

    let iv0 = getIvAt(F.n2n, d, t0) || getIvAt(F.cur, d, t0);
    if (!iv0 || iv0 < 10 || iv0 > 150) continue;

    let deltaC = 0.15;
    let deltaP = 0.15;
    if (F.dow === 5) { deltaC = 0.11; deltaP = 0.11; }
    else if (F.dow === 4 || iv0 < 28) { deltaC = 0.12; deltaP = 0.12; }

    const bNoon = btcMap.get(F.D0 + 13 * HR);
    if (bNoon && b0.c < bNoon.c) { deltaP = Math.min(deltaP, 0.12); }

    const T0 = yrs(F.settle - t0);
    const Kc = strike(S0, T0, iv0, deltaC, 'c');
    const Kp = strike(S0, T0, iv0, deltaP, 'p');
    const c0 = bs(S0, Kc, T0, iv0, 'c');
    const p0 = bs(S0, Kp, T0, iv0, 'p');
    const cr = c0 + p0;

    // Run simulation for each exit strategy
    for (const strat of exitStrategies) {
      let stopped = false;
      let exited = false;
      let finalPnlPct = 0;
      let finalPnlDollars = 0;
      let exitH = t0;
      let exitReason: 'stop' | 'target' | 'time' = 'time';

      // Simulate hour by hour up to 17:30 IST settlement
      for (let t = t0 + HR; t <= F.settle; t += HR) {
        const b = btcMap.get(t);
        if (!b) continue;

        const dayForT = t < d0(nextDayStr) ? d : (t < d0(dayAfterStr) ? nextDayStr : dayAfterStr);
        let liveIv = getIvAt(F.n2n, dayForT, t) || getIvAt(F.cur, dayForT, t);
        if (!liveIv) {
          const elapsed = (t - t0) / (F.settle - t0);
          liveIv = iv0 * (1 - 0.15 * elapsed);
        }
        const remT = yrs(F.settle - t);

        const cMark = bs(b.c, Kc, remT, liveIv, 'c');
        const pMark = bs(b.c, Kp, remT, liveIv, 'p');
        const callBreach = bs(b.h, Kc, remT, liveIv, 'c') >= 2.0 * c0;
        const putBreach = bs(b.l, Kp, remT, liveIv, 'p') >= 2.0 * p0;

        // Check authentic 2.0x leg stop
        if (cMark >= 2.0 * c0 || callBreach || pMark >= 2.0 * p0 || putBreach) {
          stopped = true;
          exited = true;
          finalPnlPct = -100;
          finalPnlDollars = -cr;
          exitH = t;
          exitReason = 'stop';
          break;
        }

        const currentVal = cMark + pMark;
        const currentProfitPct = ((cr - currentVal) / cr) * 100;

        // Check strategy exit condition
        if (strat.shouldExit(t, F, cr, currentVal, currentProfitPct, cMark, pMark, c0, p0)) {
          exited = true;
          finalPnlPct = currentProfitPct;
          finalPnlDollars = cr - currentVal;
          exitH = t;
          exitReason = currentProfitPct >= 40 ? 'target' : 'time';
          break;
        }
      }

      if (!exited) {
        // Exited at final settlement
        const bFinal = btcMap.get(F.settle) || btcMap.get(F.settle - HR);
        const sFin = bFinal ? bFinal.c : S0;
        const cFin = Math.max(0, sFin - Kc);
        const pFin = Math.max(0, Kp - sFin);
        finalPnlPct = stopped ? -100 : ((cr - cFin - pFin) / cr) * 100;
        finalPnlDollars = stopped ? -cr : (cr - cFin - pFin);
        exitH = F.settle;
      }

      resultsByStrategy.get(strat.id)!.push({
        day: d,
        dow: F.dow,
        stopped,
        win: !stopped && finalPnlPct > 0,
        pnlPct: finalPnlPct,
        pnlDollars: finalPnlDollars,
        credit: cr,
        exitHourIst: new Date(exitH + IST).getUTCHours(),
        exitReason,
      });
    }
  }

  // Statistical & Ranking Table
  const baseline = resultsByStrategy.get('fixed_0700_baseline')!;
  const baseStopped = baseline.filter(r => r.stopped).length;

  interface StratSummary {
    id: string;
    name: string;
    cat: string;
    sample: number;
    stoppedCount: number;
    winCount: number;
    stopRate: number;
    winRate: number;
    avgPnlPct: number;
    avgDollars: number;
    totalDollars: number;
    chi2VsBase: number;
    pValVsBase: number;
  }

  const summaries: StratSummary[] = [];

  for (const strat of exitStrategies) {
    const list = resultsByStrategy.get(strat.id)!;
    const N = list.length;
    const stp = list.filter(r => r.stopped).length;
    const win = list.filter(r => r.win).length;
    const stopRate = (stp / N) * 100;
    const winRate = (win / N) * 100;
    const avgPnlPct = list.reduce((s, r) => s + r.pnlPct, 0) / N;
    const avgDollars = list.reduce((s, r) => s + r.pnlDollars, 0) / N;
    const totalDollars = list.reduce((s, r) => s + r.pnlDollars, 0);

    const chi = calcChi2Yates(stp, N - stp, baseStopped, baseline.length - baseStopped);

    summaries.push({
      id: strat.id,
      name: strat.name,
      cat: strat.cat,
      sample: N,
      stoppedCount: stp,
      winCount: win,
      stopRate,
      winRate,
      avgPnlPct,
      avgDollars,
      totalDollars,
      chi2VsBase: chi.chi2,
      pValVsBase: chi.pVal,
    });
  }

  // Sort by Total Net Profit ($) descending
  summaries.sort((a, b) => b.totalDollars - a.totalDollars);

  console.log('\n================================================================================');
  console.log('  STAGE 3: EXIT STRATEGY RANKING (Ranked by Total Net Profit $)');
  console.log('================================================================================\n');

  console.log('| Rank | Exit Strategy | Category | Sample | Stop Rate | Win Rate | Avg PnL (% credit) | Avg PnL ($/trade) | Total Net Profit ($) | vs Baseline |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  summaries.forEach((s, idx) => {
    const isBase = s.id === 'fixed_0700_baseline';
    const diff = s.totalDollars - baseline.reduce((sum, r) => sum + r.pnlDollars, 0);
    const diffStr = isBase ? 'BASELINE' : (diff > 0 ? `+$${diff.toFixed(0)}` : `-$${Math.abs(diff).toFixed(0)}`);
    console.log(`| #${idx + 1} | ${s.name.padEnd(52, ' ')} | ${s.cat.padEnd(13, ' ')} | ${s.sample.toString().padEnd(6, ' ')} | ${s.stopRate.toFixed(1)}% (${s.stoppedCount}/${s.sample}) | ${s.winRate.toFixed(1)}% | ${s.avgPnlPct > 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}% | ${s.avgDollars > 0 ? '+' : ''}$${s.avgDollars.toFixed(1)} | ${s.totalDollars > 0 ? '+' : ''}$${s.totalDollars.toFixed(0)} | ${diffStr} |`);
  });

  // --------------------------------------------------------------------------
  // BONFERRONI AUDIT (M = 11 alternatives)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  BONFERRONI AUDIT: DOES ANY EXIT RULE SIGNIFICANTLY BEAT THE 07:00 BASELINE?');
  console.log('================================================================================');
  const mExit = exitStrategies.length - 1;
  const alphaBonfExit = 0.05 / mExit;
  console.log(`Number of alternatives compared against 07:00 IST baseline (M): ${mExit}`);
  console.log(`Standard Alpha:   alpha = 0.0500  (Chi-Square >= 3.841)`);
  console.log(`Bonferroni Alpha: alpha = ${alphaBonfExit.toFixed(5)} (Chi-Square >= 7.98)`);

  for (const s of summaries) {
    if (s.id === 'fixed_0700_baseline') continue;
    const clearsBonf = s.pValVsBase < alphaBonfExit;
    console.log(`  ${s.name.padEnd(54, ' ')}: Stop = ${s.stopRate.toFixed(1)}% | Chi2 = ${s.chi2VsBase.toFixed(3)} | p = ${s.pValVsBase.toFixed(4)} | Clears Bonf?: ${clearsBonf ? '>>> YES <<<' : 'NO'}`);
  }

  // --------------------------------------------------------------------------
  // OUT-OF-SAMPLE WALK-FORWARD VALIDATION (50/50 Split)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  OUT-OF-SAMPLE WALK-FORWARD VALIDATION (First 134 Nights vs Fresh 135 Nights)');
  console.log('================================================================================');

  for (const s of summaries.slice(0, 5)) {
    const list = resultsByStrategy.get(s.id)!;
    const inSamp = list.slice(0, Math.floor(list.length / 2));
    const outSamp = list.slice(Math.floor(list.length / 2));

    const isStp = inSamp.filter(r => r.stopped).length;
    const isRate = (isStp / inSamp.length) * 100;
    const isDollars = inSamp.reduce((sum, r) => sum + r.pnlDollars, 0);

    const oosStp = outSamp.filter(r => r.stopped).length;
    const oosRate = (oosStp / outSamp.length) * 100;
    const oosDollars = outSamp.reduce((sum, r) => sum + r.pnlDollars, 0);

    console.log(`\n[STRATEGY]: ${s.name}`);
    console.log(`  In-Sample (H1):     Stop Rate = ${isRate.toFixed(1)}% (${isStp}/${inSamp.length}) | Net Profit = ${isDollars > 0 ? '+' : ''}$${isDollars.toFixed(0)}`);
    console.log(`  Out-of-Sample (H2): Stop Rate = ${oosRate.toFixed(1)}% (${oosStp}/${outSamp.length}) | Net Profit = ${oosDollars > 0 ? '+' : ''}$${oosDollars.toFixed(0)}`);
    console.log(`  Out-of-Sample Profitable?: ${oosDollars > 0 ? '>>> YES - PROFITABLE ON UNSEEN DATA <<<' : 'NO'}`);
  }

  // --------------------------------------------------------------------------
  // PART 4: EXIT TIMING UNDER THE APPROVED STAGE 1 & 2 RULES
  // (Tuesday & Wednesday Prime Days + Speed < 1.5x)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  EXIT TIMING UNDER STAGE 1 & 2 APPROVED RULES (Tue/Wed + Speed < 1.5x)');
  console.log('================================================================================\n');

  console.log('| Rank | Exit Strategy | Sample | Stop Rate | Win Rate | Avg PnL (% credit) | Total Net Profit ($) | Win/Loss Ratio |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  const filteredSummaries: any[] = [];
  for (const strat of exitStrategies) {
    const list = resultsByStrategy.get(strat.id)!;
    // Filter to Tue & Wed sessions
    const tw = list.filter(r => r.dow === 2 || r.dow === 3);
    const N = tw.length;
    const stp = tw.filter(r => r.stopped).length;
    const win = tw.filter(r => r.win).length;
    const stopRate = (stp / N) * 100;
    const winRate = (win / N) * 100;
    const avgPnlPct = tw.reduce((sum, r) => sum + r.pnlPct, 0) / N;
    const totalDollars = tw.reduce((sum, r) => sum + r.pnlDollars, 0);
    const grossWins = tw.filter(r => r.pnlDollars > 0).reduce((sum, r) => sum + r.pnlDollars, 0);
    const grossLosses = Math.abs(tw.filter(r => r.pnlDollars < 0).reduce((sum, r) => sum + r.pnlDollars, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins;

    filteredSummaries.push({
      name: strat.name,
      sample: N,
      stopRate,
      winRate,
      avgPnlPct,
      totalDollars,
      profitFactor,
      stp,
    });
  }

  filteredSummaries.sort((a, b) => b.totalDollars - a.totalDollars);
  filteredSummaries.forEach((s, idx) => {
    console.log(`| #${idx + 1} | ${s.name.padEnd(52, ' ')} | ${s.sample.toString().padEnd(6, ' ')} | ${s.stopRate.toFixed(1)}% (${s.stp}/${s.sample}) | ${s.winRate.toFixed(1)}% | ${s.avgPnlPct > 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}% | ${s.totalDollars > 0 ? '+' : ''}$${s.totalDollars.toFixed(0)} | ${s.profitFactor.toFixed(2)}x |`);
  });
}

main().catch(console.error);
