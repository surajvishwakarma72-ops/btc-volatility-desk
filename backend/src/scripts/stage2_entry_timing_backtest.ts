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
  console.log('  STAGE 2 BACKTEST: OPTIMAL ENTRY TIMING FOR THE TRADE CLOCK');
  console.log('  Testing Fixed Times vs Waiting for Triggers (IV Turn, Speed Drop, Cool-off)');
  console.log('  Rigorous Validation: 269 Real Sessions (Oct 2025 - Oct 2026), Bonferroni & OOS');
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

  // Define the Entry Timing Models to Test
  interface TimingModel {
    id: string;
    name: string;
    description: string;
    // Returns timestamp ms of chosen entry, or null if condition never met
    getEntryTime: (F: any, day: string) => number | null;
  }

  const timingModels: TimingModel[] = [
    {
      id: 'fixed_ny_open',
      name: 'Fixed at NY Open (19:30 EDT / 20:30 EST)',
      description: 'Zero wait; enter immediately at the opening bell',
      getEntryTime: (F, day) => F.open,
    },
    {
      id: 'fixed_wait_30m',
      name: 'Wait 30 Min after NY Open',
      description: 'Quick cool-off; 30 min after NY open',
      getEntryTime: (F, day) => F.open + 30 * MIN,
    },
    {
      id: 'fixed_wait_60m',
      name: 'Wait 60 Min after NY Open (Baseline Desk Default)',
      description: 'Standard 60 min initial cool-off (20:30/21:30)',
      getEntryTime: (F, day) => F.open + 60 * MIN,
    },
    {
      id: 'fixed_wait_90m',
      name: 'Wait 90 Min after NY Open',
      description: '90 min patient cool-off',
      getEntryTime: (F, day) => F.open + 90 * MIN,
    },
    {
      id: 'fixed_wait_120m',
      name: 'Wait 120 Min after NY Open (21:30 EDT / 22:30 EST)',
      description: 'Late evening entry',
      getEntryTime: (F, day) => F.open + 120 * MIN,
    },
    {
      id: 'fixed_wait_180m',
      name: 'Wait 180 Min after NY Open (22:30 EDT / 23:30 EST)',
      description: 'Pre-midnight late entry',
      getEntryTime: (F, day) => F.open + 180 * MIN,
    },
    {
      id: 'trigger_iv_turn_15',
      name: 'IV Turn Trigger (>= 1.5% off NY Peak)',
      description: 'Wait for peak IV in first 3h, then enter when IV drops 1.5% off high',
      getEntryTime: (F, day) => {
        let maxIv = 0;
        let peakTime = F.open;
        for (let m = 0; m <= 240; m += 15) {
          const t = F.open + m * MIN;
          const iv = getIvAt(F.n2n, day, t) || getIvAt(F.cur, day, t);
          if (iv && iv > maxIv) {
            maxIv = iv;
            peakTime = t;
          }
          if (maxIv > 0 && iv) {
            const dropPct = (maxIv - iv) / maxIv * 100;
            // After at least 30m, if drop is >= 1.5%, trigger entry
            if (m >= 30 && dropPct >= 1.5) {
              return t;
            }
          }
        }
        return F.open + 60 * MIN; // fallback to 60m if no drop
      },
    },
    {
      id: 'trigger_iv_turn_30',
      name: 'Deep IV Turn Trigger (>= 3.0% off NY Peak)',
      description: 'Wait for peak IV, enter when IV drops >= 3.0% off high',
      getEntryTime: (F, day) => {
        let maxIv = 0;
        for (let m = 0; m <= 240; m += 15) {
          const t = F.open + m * MIN;
          const iv = getIvAt(F.n2n, day, t) || getIvAt(F.cur, day, t);
          if (iv && iv > maxIv) maxIv = iv;
          if (maxIv > 0 && iv) {
            const dropPct = (maxIv - iv) / maxIv * 100;
            if (m >= 30 && dropPct >= 3.0) return t;
          }
        }
        return F.open + 90 * MIN; // fallback
      },
    },
    {
      id: 'trigger_speed_calm',
      name: 'Speed Calm Trigger (First time Speed < 1.5x after open)',
      description: 'Check every 30m; enter the moment Speed vs IV drops under 1.5x',
      getEntryTime: (F, day) => {
        for (let m = 30; m <= 240; m += 30) {
          const t = F.open + m * MIN;
          const iv = getIvAt(F.n2n, day, t) || getIvAt(F.cur, day, t);
          const rv6 = getRv(t, 6);
          if (iv && rv6 && (rv6 / iv < 1.5)) return t;
        }
        return F.open + 60 * MIN; // fallback
      },
    },
    {
      id: 'trigger_combined_desk',
      name: 'Combined Authentic Trigger (Wait 60m + IV Turn + Speed < 1.5x)',
      description: 'Wait minimum 60 min, require IV falling & Speed < 1.5x',
      getEntryTime: (F, day) => {
        let maxIv = 0;
        for (let m = 0; m <= 60; m += 15) {
          const t = F.open + m * MIN;
          const iv = getIvAt(F.n2n, day, t) || getIvAt(F.cur, day, t);
          if (iv && iv > maxIv) maxIv = iv;
        }
        for (let m = 60; m <= 240; m += 30) {
          const t = F.open + m * MIN;
          const iv = getIvAt(F.n2n, day, t) || getIvAt(F.cur, day, t);
          const rv6 = getRv(t, 6);
          if (iv && iv > maxIv) maxIv = iv;
          const dropPct = maxIv > 0 && iv ? (maxIv - iv) / maxIv * 100 : 0;
          const speedOk = rv6 != null && iv != null && (rv6 / iv < 1.5);
          if (dropPct >= 1.0 && speedOk) return t;
        }
        return F.open + 90 * MIN;
      },
    },
  ];

  interface SimulationResult {
    day: string;
    dow: number;
    stopped: boolean;
    win: boolean;
    pnlPct: number;
    credit: number;
    entryTime: number;
    entryIv: number;
    spot: number;
  }

  // Map of modelId -> array of SimulationResult
  const modelResults = new Map<string, SimulationResult[]>();
  for (const m of timingModels) modelResults.set(m.id, []);

  for (let i = 0; i < sortedDays.length; i++) {
    const d = sortedDays[i];
    const nextDayStr = sortedDays[i + 1] || dk(Date.parse(d + 'T12:00:00Z') + DAY);
    const F = frame(d0(d) + 20 * HR);
    if (F.dow === 0 || F.dow === 6) continue;

    for (const model of timingModels) {
      const rawEntryT = model.getEntryTime(F, d);
      if (!rawEntryT) continue;
      const entryH = Math.floor(rawEntryT / HR) * HR;

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

      let stopped = false;
      let finalClose = S0;
      const exitH = Math.floor(F.exit / HR) * HR;

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
        const callIntrabarBreach = bs(b.h, Kc, remT, liveIv, 'c') >= 2.0 * c0;
        const putIntrabarBreach = bs(b.l, Kp, remT, liveIv, 'p') >= 2.0 * p0;

        if (cMark >= 2.0 * c0 || callIntrabarBreach || pMark >= 2.0 * p0 || putIntrabarBreach) {
          stopped = true;
          break;
        }
      }

      const remT = yrs(F.settle - exitH);
      const exitIv = getIvAt(F.n2n, nextDayStr, exitH) || iv0 * 0.94;
      const cFinal = bs(finalClose, Kc, remT, exitIv, 'c');
      const pFinal = bs(finalClose, Kp, remT, exitIv, 'p');
      const pnlPct = stopped ? -100 : ((cr - cFinal - pFinal) / cr) * 100;
      const win = !stopped && pnlPct > 0;

      modelResults.get(model.id)!.push({
        day: d,
        dow: F.dow,
        stopped,
        win,
        pnlPct,
        credit: cr,
        entryTime: t0,
        entryIv: iv0,
        spot: S0,
      });
    }
  }

  // Performance summary table
  interface TimingSummary {
    id: string;
    name: string;
    sample: number;
    stopRate: number;
    winRate: number;
    avgPnlPct: number;
    avgCredit: number;
    stoppedCount: number;
    winCount: number;
    chi2VsBaseline: number;
    pValVsBaseline: number;
  }

  const baselineResults = modelResults.get('fixed_wait_60m')!;
  const baselineStopRate = (baselineResults.filter(r => r.stopped).length / baselineResults.length) * 100;

  const summaries: TimingSummary[] = [];

  for (const model of timingModels) {
    const list = modelResults.get(model.id)!;
    const N = list.length;
    const stp = list.filter(r => r.stopped).length;
    const win = list.filter(r => r.win).length;
    const stopRate = (stp / N) * 100;
    const winRate = (win / N) * 100;
    const avgPnlPct = list.reduce((s, r) => s + r.pnlPct, 0) / N;
    const avgCredit = list.reduce((s, r) => s + r.credit, 0) / N;

    // Chi-Square against 60m baseline
    const a = stp;
    const b = N - stp;
    const c = baselineResults.filter(r => r.stopped).length;
    const d = baselineResults.length - c;
    const chi = calcChi2Yates(a, b, c, d);

    summaries.push({
      id: model.id,
      name: model.name,
      sample: N,
      stopRate,
      winRate,
      avgPnlPct,
      avgCredit,
      stoppedCount: stp,
      winCount: win,
      chi2VsBaseline: chi.chi2,
      pValVsBaseline: chi.pVal,
    });
  }

  // Sort by Stop Rate ascending
  summaries.sort((a, b) => a.stopRate - b.stopRate);

  console.log('\n================================================================================');
  console.log('  STAGE 2: ENTRY TIMING RANKING (Lowest Stop-Loss Rate to Highest)');
  console.log('================================================================================\n');

  console.log('| Rank | Entry Timing Rule | Sample | Stop Rate | Win Rate | Avg PnL (% credit) | Avg Credit ($) | vs Baseline (60m) |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  summaries.forEach((s, idx) => {
    const spread = baselineStopRate - s.stopRate;
    const spreadStr = spread > 0 ? `+${spread.toFixed(1)}% safer` : `${spread.toFixed(1)}% worse`;
    console.log(`| #${idx + 1} | ${s.name.padEnd(52, ' ')} | ${s.sample.toString().padEnd(6, ' ')} | ${s.stopRate.toFixed(1)}% (${s.stoppedCount}/${s.sample}) | ${s.winRate.toFixed(1)}% | ${s.avgPnlPct > 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}% | $${s.avgCredit.toFixed(0)} | ${s.id === 'fixed_wait_60m' ? 'BASELINE' : spreadStr} |`);
  });

  // --------------------------------------------------------------------------
  // BONFERRONI CORRECTION ON ENTRY TIMING (M = 10 hypotheses)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  BONFERRONI AUDIT: DOES ANY TIMING TRIGGER SIGNIFICANTLY BEAT FIXED TIME?');
  console.log('================================================================================');
  const mTiming = timingModels.length - 1; // comparing 9 against baseline
  const alphaBonfTiming = 0.05 / mTiming;
  console.log(`Number of alternatives compared against baseline (M): ${mTiming}`);
  console.log(`Standard Alpha:   alpha = 0.0500`);
  console.log(`Bonferroni Alpha: alpha = ${alphaBonfTiming.toFixed(5)}`);

  for (const s of summaries) {
    if (s.id === 'fixed_wait_60m') continue;
    const clearsBonf = s.pValVsBaseline < alphaBonfTiming;
    console.log(`  ${s.name.padEnd(50, ' ')}: Stop = ${s.stopRate.toFixed(1)}% | Chi2 = ${s.chi2VsBaseline.toFixed(3)} | p = ${s.pValVsBaseline.toFixed(4)} | Clears Bonf?: ${clearsBonf ? 'YES' : 'NO'}`);
  }

  // --------------------------------------------------------------------------
  // WALK-FORWARD OUT-OF-SAMPLE TEST (50/50 Temporal Split)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  OUT-OF-SAMPLE / WALK-FORWARD VALIDATION ACROSS TIMING MODELS');
  console.log('================================================================================');
  const splitIdx = Math.floor(sortedDays.length / 2);

  for (const s of summaries.slice(0, 5)) {
    const list = modelResults.get(s.id)!;
    const inSamp = list.slice(0, Math.floor(list.length / 2));
    const outSamp = list.slice(Math.floor(list.length / 2));

    const isStp = inSamp.filter(r => r.stopped).length;
    const isRate = (isStp / inSamp.length) * 100;
    const isPnl = inSamp.reduce((sum, r) => sum + r.pnlPct, 0) / inSamp.length;

    const oosStp = outSamp.filter(r => r.stopped).length;
    const oosRate = (oosStp / outSamp.length) * 100;
    const oosPnl = outSamp.reduce((sum, r) => sum + r.pnlPct, 0) / outSamp.length;

    console.log(`\n[MODEL]: ${s.name}`);
    console.log(`  In-Sample (H1):      Stop Rate = ${isRate.toFixed(1)}% (${isStp}/${inSamp.length}) | Avg PnL = ${isPnl.toFixed(1)}%`);
    console.log(`  Out-of-Sample (H2):  Stop Rate = ${oosRate.toFixed(1)}% (${oosStp}/${outSamp.length}) | Avg PnL = ${oosPnl.toFixed(1)}%`);
    console.log(`  Stability:           ${Math.abs(isRate - oosRate) < 10 ? 'STABLE' : 'DRIFT'}`);
  }

  // --------------------------------------------------------------------------
  // PART 4: TIMING ON TUESDAY & WEDNESDAY (STAGE 1 CORE DAYS)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  TIMING PERFORMANCE ON STAGE 1 CORE (TUESDAY & WEDNESDAY ONLY)');
  console.log('================================================================================\n');

  console.log('| Rank | Entry Timing Rule | Tue/Wed N | Stop Rate | Win Rate | Avg PnL (% credit) | Avg PnL ($ / trade) | Avg Credit ($) |');
  console.log('| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |');

  const twSummaries: any[] = [];
  for (const model of timingModels) {
    const list = modelResults.get(model.id)!.filter(r => r.dow === 2 || r.dow === 3);
    const N = list.length;
    const stp = list.filter(r => r.stopped).length;
    const win = list.filter(r => r.win).length;
    const stopRate = (stp / N) * 100;
    const winRate = (win / N) * 100;
    const avgPnlPct = list.reduce((s, r) => s + r.pnlPct, 0) / N;
    const avgCredit = list.reduce((s, r) => s + r.credit, 0) / N;
    const avgDollarPnl = list.reduce((s, r) => s + (r.pnlPct / 100) * r.credit, 0) / N;

    twSummaries.push({
      name: model.name,
      sample: N,
      stopRate,
      winRate,
      avgPnlPct,
      avgDollarPnl,
      avgCredit,
      stp,
    });
  }

  twSummaries.sort((a, b) => a.stopRate - b.stopRate);
  twSummaries.forEach((s, idx) => {
    console.log(`| #${idx + 1} | ${s.name.padEnd(52, ' ')} | ${s.sample.toString().padEnd(9, ' ')} | ${s.stopRate.toFixed(1)}% (${s.stp}/${s.sample}) | ${s.winRate.toFixed(1)}% | ${s.avgPnlPct > 0 ? '+' : ''}${s.avgPnlPct.toFixed(1)}% | ${s.avgDollarPnl > 0 ? '+' : ''}$${s.avgDollarPnl.toFixed(1)} | $${s.avgCredit.toFixed(0)} |`);
  });
}

main().catch(console.error);
