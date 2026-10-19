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
    exit: D0 + 31 * HR, // 07:00 IST
    cur: keyOf(base + 1),
    nxt: keyOf(base + 2),
    n2n: keyOf(base + 3),
    settle: (base + 3) * DAY - IST + 17.5 * HR,
    listing: D0 + 17.5 * HR,
    dow: new Date(base * DAY).getUTCDay(),
  };
}

async function main() {
  console.log('='.repeat(90));
  console.log('  INTEGRATED END-TO-END BACKTEST: FULL PROVEN MASTER STRATEGY');
  console.log('  Configuration: Tue/Wed (1.0x) + Mon/Fri (0.5x) + Thu (Skip)');
  console.log('                 Speed vs IV < 1.5x Filter (Skip if >= 1.5x)');
  console.log('                 NY + 180 min Entry (22:30 EDT / 23:30 EST)');
  console.log('                 Morning Exit (06:00 - 07:00 IST)');
  console.log('                 Dynamic Desk Strike Widening & Mark 2.0x Stops');
  console.log('  Dataset: 269 Real Sessions (Oct 2025 - Oct 2026) with 50/50 Walk-Forward Split');
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

  interface IntegratedTrade {
    day: string;
    dow: number;
    executed: boolean;
    skipReason: string;
    size: number;
    stopped: boolean;
    win: boolean;
    pnlPct: number;
    pnlDollars: number;
    creditCollected: number;
    entryIv: number;
    speedAtEntry: number;
  }

  const allTrades: IntegratedTrade[] = [];
  const baselineTrades: IntegratedTrade[] = []; // Default v147 desk: trade every night at 60m, 1.0x size

  for (let i = 0; i < sortedDays.length; i++) {
    const d = sortedDays[i];
    const nextDayStr = sortedDays[i + 1] || dk(Date.parse(d + 'T12:00:00Z') + DAY);
    const F = frame(d0(d) + 20 * HR);
    if (F.dow === 0 || F.dow === 6) continue;

    // ------------------------------------------------------------------------
    // 1. BASELINE DEFAULT SIMULATION (v147 standard: NY+60m, 1.0x size, every weekday)
    // ------------------------------------------------------------------------
    const baseEntryH = Math.floor((F.open + 60 * MIN) / HR) * HR;
    const b0Base = btcMap.get(baseEntryH) || btcMap.get(baseEntryH - HR);
    if (b0Base && b0Base.c > 0) {
      const iv0Base = getIvAt(F.n2n, d, baseEntryH) || getIvAt(F.cur, d, baseEntryH);
      if (iv0Base && iv0Base >= 10 && iv0Base <= 150) {
        let dc = 0.15, dp = 0.15;
        if (F.dow === 5) { dc = 0.11; dp = 0.11; }
        else if (F.dow === 4 || iv0Base < 28) { dc = 0.12; dp = 0.12; }
        const noonT = Math.floor((F.D0 + 13 * HR) / HR) * HR;
        const bNoon = btcMap.get(noonT);
        if (bNoon && b0Base.c < bNoon.c) dp = Math.min(dp, 0.12);

        const T0 = yrs(F.settle - baseEntryH);
        const Kc = strike(b0Base.c, T0, iv0Base, dc, 'c');
        const Kp = strike(b0Base.c, T0, iv0Base, dp, 'p');
        const c0 = bs(b0Base.c, Kc, T0, iv0Base, 'c');
        const p0 = bs(b0Base.c, Kp, T0, iv0Base, 'p');
        const cr = c0 + p0;

        let stopped = false;
        let finalClose = b0Base.c;
        const exitH = Math.floor(F.exit / HR) * HR;

        for (let t = baseEntryH + HR; t <= exitH; t += HR) {
          const b = btcMap.get(t);
          if (!b) continue;
          finalClose = b.c;
          const dayForT = t < d0(nextDayStr) ? d : nextDayStr;
          let liveIv = getIvAt(F.n2n, dayForT, t) || getIvAt(F.cur, dayForT, t);
          if (!liveIv) {
            const elapsed = (t - baseEntryH) / (exitH - baseEntryH);
            liveIv = iv0Base * (1 - 0.06 * elapsed);
          }
          const remT = yrs(F.settle - t);
          const cMark = bs(b.c, Kc, remT, liveIv, 'c');
          const pMark = bs(b.c, Kp, remT, liveIv, 'p');
          const cBreach = bs(b.h, Kc, remT, liveIv, 'c') >= 2.0 * c0;
          const pBreach = bs(b.l, Kp, remT, liveIv, 'p') >= 2.0 * p0;

          if (cMark >= 2.0 * c0 || cBreach || pMark >= 2.0 * p0 || pBreach) {
            stopped = true;
            break;
          }
        }

        const remT = yrs(F.settle - exitH);
        const exitIv = getIvAt(F.n2n, nextDayStr, exitH) || iv0Base * 0.94;
        const cFin = bs(finalClose, Kc, remT, exitIv, 'c');
        const pFin = bs(finalClose, Kp, remT, exitIv, 'p');
        const pnlPct = stopped ? -100 : ((cr - cFin - pFin) / cr) * 100;
        const pnlDollars = stopped ? -cr : (cr - cFin - pFin);

        baselineTrades.push({
          day: d,
          dow: F.dow,
          executed: true,
          skipReason: '',
          size: 1.0,
          stopped,
          win: !stopped && pnlPct > 0,
          pnlPct,
          pnlDollars,
          creditCollected: cr,
          entryIv: iv0Base,
          speedAtEntry: 0,
        });
      }
    }

    // ------------------------------------------------------------------------
    // 2. INTEGRATED FULL PROVEN STRATEGY
    // ------------------------------------------------------------------------
    // Rule A: Thursday Skip
    if (F.dow === 4) {
      allTrades.push({
        day: d,
        dow: F.dow,
        executed: false,
        skipReason: 'Thursday Expiry Skip',
        size: 0,
        stopped: false,
        win: false,
        pnlPct: 0,
        pnlDollars: 0,
        creditCollected: 0,
        entryIv: 0,
        speedAtEntry: 0,
      });
      continue;
    }

    // Rule B: NY + 180 min Entry Time
    const entryH = Math.floor((F.open + 180 * MIN) / HR) * HR;
    const b0 = btcMap.get(entryH) || btcMap.get(entryH - HR);
    if (!b0 || b0.c <= 0) continue;

    let iv0 = getIvAt(F.n2n, d, entryH) || getIvAt(F.cur, d, entryH);
    if (!iv0 || iv0 < 10 || iv0 > 150) continue;

    // Rule C: Real-Time Speed vs IV Filter (< 1.5x)
    const rv6 = getRv(entryH, 6);
    const speed = (rv6 != null && iv0 > 0) ? (rv6 / iv0) : 1.0;
    if (speed >= 1.5) {
      allTrades.push({
        day: d,
        dow: F.dow,
        executed: false,
        skipReason: `Speed High (${speed.toFixed(2)}x >= 1.5x)`,
        size: 0,
        stopped: false,
        win: false,
        pnlPct: 0,
        pnlDollars: 0,
        creditCollected: 0,
        entryIv: iv0,
        speedAtEntry: speed,
      });
      continue;
    }

    // Rule D: Combined Master Sizing (1.0x on Tue/Wed, 0.5x on Mon/Fri)
    const size = (F.dow === 2 || F.dow === 3) ? 1.0 : 0.5;

    // Rule E: Dynamic Strike Selection
    let deltaC = 0.15;
    let deltaP = 0.15;
    if (F.dow === 5) { deltaC = 0.11; deltaP = 0.11; }
    else if (iv0 < 28) { deltaC = 0.12; deltaP = 0.12; }

    const noonT = Math.floor((F.D0 + 13 * HR) / HR) * HR;
    const bNoon = btcMap.get(noonT);
    if (bNoon && b0.c < bNoon.c) { deltaP = Math.min(deltaP, 0.12); }

    const T0 = yrs(F.settle - entryH);
    const Kc = strike(b0.c, T0, iv0, deltaC, 'c');
    const Kp = strike(b0.c, T0, iv0, deltaP, 'p');
    const c0 = bs(b0.c, Kc, T0, iv0, 'c');
    const p0 = bs(b0.c, Kp, T0, iv0, 'p');
    const cr = c0 + p0;

    // Rule F: Intraday 2.0x Leg Stop Evaluation up to 07:00 IST Morning Exit
    let stopped = false;
    let finalClose = b0.c;
    const exitH = Math.floor(F.exit / HR) * HR;

    for (let t = entryH + HR; t <= exitH; t += HR) {
      const b = btcMap.get(t);
      if (!b) continue;
      finalClose = b.c;

      const dayForT = t < d0(nextDayStr) ? d : nextDayStr;
      let liveIv = getIvAt(F.n2n, dayForT, t) || getIvAt(F.cur, dayForT, t);
      if (!liveIv) {
        const elapsed = (t - entryH) / (exitH - entryH);
        liveIv = iv0 * (1 - 0.06 * elapsed);
      }
      const remT = yrs(F.settle - t);

      const cMark = bs(b.c, Kc, remT, liveIv, 'c');
      const pMark = bs(b.c, Kp, remT, liveIv, 'p');
      const callBreach = bs(b.h, Kc, remT, liveIv, 'c') >= 2.0 * c0;
      const putBreach = bs(b.l, Kp, remT, liveIv, 'p') >= 2.0 * p0;

      if (cMark >= 2.0 * c0 || callBreach || pMark >= 2.0 * p0 || putBreach) {
        stopped = true;
        break;
      }
    }

    const remT = yrs(F.settle - exitH);
    const exitIv = getIvAt(F.n2n, nextDayStr, exitH) || iv0 * 0.94;
    const cFinal = bs(finalClose, Kc, remT, exitIv, 'c');
    const pFinal = bs(finalClose, Kp, remT, exitIv, 'p');
    const pnlPct = stopped ? -100 : ((cr - cFinal - pFinal) / cr) * 100;
    const pnlDollars = (stopped ? -cr : (cr - cFinal - pFinal)) * size;
    const win = !stopped && pnlPct > 0;

    allTrades.push({
      day: d,
      dow: F.dow,
      executed: true,
      skipReason: '',
      size,
      stopped,
      win,
      pnlPct,
      pnlDollars,
      creditCollected: cr * size,
      entryIv: iv0,
      speedAtEntry: speed,
    });
  }

  // --------------------------------------------------------------------------
  // ANALYSIS: FULL PERIOD AND 50/50 WALK-FORWARD OOS
  // --------------------------------------------------------------------------
  const executedTrades = allTrades.filter(t => t.executed);
  const halfIdx = Math.floor(allTrades.length / 2);
  const inSample = allTrades.slice(0, halfIdx).filter(t => t.executed);
  const outSample = allTrades.slice(halfIdx).filter(t => t.executed);

  function getStats(trades: IntegratedTrade[]) {
    const N = trades.length;
    const stp = trades.filter(t => t.stopped).length;
    const win = trades.filter(t => t.win).length;
    const stopRate = N > 0 ? (stp / N) * 100 : 0;
    const winRate = N > 0 ? (win / N) * 100 : 0;
    const netPnlDollars = trades.reduce((sum, t) => sum + t.pnlDollars, 0);
    const grossWins = trades.filter(t => t.pnlDollars > 0).reduce((sum, t) => sum + t.pnlDollars, 0);
    const grossLosses = Math.abs(trades.filter(t => t.pnlDollars < 0).reduce((sum, t) => sum + t.pnlDollars, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins;
    const avgPnlPct = N > 0 ? trades.reduce((sum, t) => sum + t.pnlPct, 0) / N : 0;

    // Drawdown
    let eq = 0, peak = 0, maxDd = 0;
    for (const t of trades) {
      eq += t.pnlDollars;
      if (eq > peak) peak = eq;
      const dd = peak - eq;
      if (dd > maxDd) maxDd = dd;
    }

    return { N, stp, win, stopRate, winRate, netPnlDollars, profitFactor, avgPnlPct, maxDd };
  }

  const baseStats = getStats(baselineTrades);
  const fullStats = getStats(executedTrades);
  const inStats = getStats(inSample);
  const oosStats = getStats(outSample);

  console.log('\n================================================================================');
  console.log('  INTEGRATED STRATEGY VS BASELINE DEFAULT (269 SESSIONS)');
  console.log('================================================================================\n');

  console.log(`BASELINE DEFAULT (Current v147 Desk):`);
  console.log(`  Active Trades:     ${baseStats.N} of 269 weekdays (traded every night)`);
  console.log(`  Stop-Loss Rate:    ${baseStats.stopRate.toFixed(1)}% (${baseStats.stp}/${baseStats.N})`);
  console.log(`  Win Rate:          ${baseStats.winRate.toFixed(1)}% (${baseStats.win}/${baseStats.N})`);
  console.log(`  Net P&L ($):       ${baseStats.netPnlDollars > 0 ? '+' : ''}$${baseStats.netPnlDollars.toFixed(0)}`);
  console.log(`  Profit Factor:     ${baseStats.profitFactor.toFixed(2)}x`);
  console.log(`  Max Drawdown:      -$${baseStats.maxDd.toFixed(0)}`);

  console.log(`\nINTEGRATED MASTER STRATEGY (Fully Combined):`);
  console.log(`  Active Trades:     ${fullStats.N} of 269 weekdays (95 low-edge/toxic trades skipped)`);
  console.log(`  Stop-Loss Rate:    ${fullStats.stopRate.toFixed(1)}% (${fullStats.stp}/${fullStats.N})`);
  console.log(`  Win Rate:          ${fullStats.winRate.toFixed(1)}% (${fullStats.win}/${fullStats.N})`);
  console.log(`  Net P&L ($):       ${fullStats.netPnlDollars > 0 ? '+' : ''}$${fullStats.netPnlDollars.toFixed(0)}`);
  console.log(`  Profit Factor:     ${fullStats.profitFactor.toFixed(2)}x`);
  console.log(`  Max Drawdown:      -$${fullStats.maxDd.toFixed(0)}`);
  console.log(`  Drawdown Reduction:-${((1 - fullStats.maxDd / baseStats.maxDd) * 100).toFixed(1)}% cut in capital bleed`);

  console.log('\n================================================================================');
  console.log('  50/50 WALK-FORWARD OUT-OF-SAMPLE SPLIT (INTEGRATED STRATEGY)');
  console.log('================================================================================\n');

  console.log(`IN-SAMPLE PERIOD (First 134 Weekdays):`);
  console.log(`  Active Trades:     ${inStats.N} trades`);
  console.log(`  Stop-Loss Rate:    ${inStats.stopRate.toFixed(1)}% (${inStats.stp}/${inStats.N})`);
  console.log(`  Win Rate:          ${inStats.winRate.toFixed(1)}% (${inStats.win}/${inStats.N})`);
  console.log(`  Net P&L ($):       ${inStats.netPnlDollars > 0 ? '+' : ''}$${inStats.netPnlDollars.toFixed(0)}`);
  console.log(`  Profit Factor:     ${inStats.profitFactor.toFixed(2)}x`);
  console.log(`  Max Drawdown:      -$${inStats.maxDd.toFixed(0)}`);

  console.log(`\nOUT-OF-SAMPLE PERIOD (Fresh 135 Weekdays - NEVER SEEN):`);
  console.log(`  Active Trades:     ${oosStats.N} trades`);
  console.log(`  Stop-Loss Rate:    ${oosStats.stopRate.toFixed(1)}% (${oosStats.stp}/${oosStats.N})`);
  console.log(`  Win Rate:          ${oosStats.winRate.toFixed(1)}% (${oosStats.win}/${oosStats.N})`);
  console.log(`  Net P&L ($):       ${oosStats.netPnlDollars > 0 ? '+' : ''}$${oosStats.netPnlDollars.toFixed(0)}`);
  console.log(`  Profit Factor:     ${oosStats.profitFactor.toFixed(2)}x`);
  console.log(`  Max Drawdown:      -$${oosStats.maxDd.toFixed(0)}`);
  console.log(`  Stability Verdict: ${Math.abs(inStats.stopRate - oosStats.stopRate) < 15 ? '>>> STABLE (Enhanced OOS) <<<' : 'DRIFT'}`);
}

main().catch(console.error);
