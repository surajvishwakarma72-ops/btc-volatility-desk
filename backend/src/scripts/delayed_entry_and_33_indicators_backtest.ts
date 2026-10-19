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

function bs(S: number, K: number, T: number, ivPct: number, type: 'c' | 'p'): number {
  if (T <= 0.00001 || ivPct <= 0.01) return type === 'c' ? Math.max(0, S - K) : Math.max(0, K - S);
  const v = ivPct / 100;
  const sT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * v * v * T) / (v * sT);
  const d2 = d1 - v * sT;
  if (type === 'c') return S * ncdf(d1) - K * ncdf(d2);
  return K * ncdf(-d2) - S * ncdf(-d1);
}

function strike(S: number, T: number, ivPct: number, deltaTarget: number, type: 'c' | 'p'): number {
  const v = ivPct / 100;
  const sT = Math.sqrt(T);
  if (type === 'c') {
    const d1 = ppf(1 - deltaTarget);
    const K = S * Math.exp(-d1 * v * sT + 0.5 * v * v * T);
    return Math.round(K / 500) * 500;
  } else {
    const d1 = ppf(deltaTarget);
    const K = S * Math.exp(-d1 * v * sT + 0.5 * v * v * T);
    return Math.round(K / 500) * 500;
  }
}

function yrs(ms: number): number {
  return Math.max(0.0001, ms / (365.25 * DAY));
}

function d0(str: string): number {
  return new Date(str + 'T00:00:00Z').getTime() - IST;
}

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
  const nyClose = D0 + (edt ? 25.5 : 26.5) * HR; // 01:30 or 02:30 IST
  return {
    base,
    D0,
    edt,
    open,
    nyClose,
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

async function runBacktest() {
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
  const days = [...dateSet].sort();

  console.log(`Starting Delay & Timing Backtest on ${days.length} days...`);

  // We want to test:
  // 1. Model A: Standard NY+180m (22:30 IST) - Skip if Speed >= 1.5x
  // 2. Model B: Dynamic Delay: At 22:30 IST, if Speed < 1.5x enter immediately.
  //             If Speed >= 1.5x, check every 30m up to NY Close (01:30/02:30 IST).
  //             If Speed drops < 1.5x, enter at that delayed time!
  // 3. Model C: Dynamic Delay Weekend Extended (Saturday/Sunday up to 03:00 IST).
  // 4. Model D: Fixed Late Entry at NY Close (01:30 IST).
  // 5. Model E: Fixed Late Entry at 03:00 IST.

  interface SimResult {
    trades: number;
    wins: number;
    stops: number;
    skipped: number;
    delayedEntries: number;
    prodPnl: number;
    stressPnl: number;
    avgCredit: number;
  }

  function simulateTiming(
    modelType: 'std' | 'dyn_delay_ny_close' | 'dyn_delay_3am' | 'fixed_ny_close' | 'fixed_3am',
    includeWeekends: boolean = false
  ): SimResult {
    let trades = 0, wins = 0, stops = 0, skipped = 0, delayedEntries = 0;
    let prodPnl = 0, stressPnl = 0, totalCredit = 0;

    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      const nextDayStr = days[i + 1] || dk(Date.parse(d + 'T12:00:00Z') + DAY);
      const F = frame(d0(d) + 20 * HR);

      if (!includeWeekends && (F.dow === 0 || F.dow === 6)) continue;
      if (F.dow === 4) { skipped++; continue; } // Thursday skip

      const size = (F.dow === 2 || F.dow === 3) ? 1.0 : 0.5;

      let chosenEntryH: number | null = null;
      let wasDelayed = false;

      const baseEntryH = Math.floor((F.open + 180 * MIN) / HR) * HR; // 22:30/23:30 IST

      if (modelType === 'std') {
        const rv6 = getRv(baseEntryH, 6);
        const iv = getIvAt(F.n2n, d, baseEntryH) || getIvAt(F.cur, d, baseEntryH);
        if (!iv) continue;
        const speed = (rv6 != null && iv > 0) ? (rv6 / iv) : 1.0;
        if (speed < 1.5) chosenEntryH = baseEntryH;
        else skipped++;
      } else if (modelType === 'dyn_delay_ny_close' || modelType === 'dyn_delay_3am') {
        const maxLimitH = modelType === 'dyn_delay_3am' 
          ? (F.D0 + 27 * HR) // 03:00 IST
          : (F.dow === 0 || F.dow === 6 ? F.D0 + 27 * HR : F.nyClose);

        // Scan from baseEntryH to maxLimitH in 30-min steps
        for (let t = baseEntryH; t <= maxLimitH; t += 30 * MIN) {
          const tH = Math.floor(t / HR) * HR;
          const rv6 = getRv(tH, 6);
          const iv = getIvAt(F.n2n, d, tH) || getIvAt(F.cur, d, tH);
          if (!iv) continue;
          const speed = (rv6 != null && iv > 0) ? (rv6 / iv) : 1.0;
          if (speed < 1.5) {
            chosenEntryH = tH;
            if (t > baseEntryH) wasDelayed = true;
            break;
          }
        }
        if (!chosenEntryH) skipped++;
      } else if (modelType === 'fixed_ny_close') {
        chosenEntryH = Math.floor(F.nyClose / HR) * HR;
      } else if (modelType === 'fixed_3am') {
        chosenEntryH = F.D0 + 27 * HR; // 03:00 IST
      }

      if (!chosenEntryH) continue;
      if (wasDelayed) delayedEntries++;

      const b0 = btcMap.get(chosenEntryH) || btcMap.get(chosenEntryH - HR);
      if (!b0 || b0.c <= 0) continue;

      const dayForLookup = chosenEntryH >= d0(nextDayStr) ? nextDayStr : d;
      let iv0 = getIvAt(F.n2n, dayForLookup, chosenEntryH) || getIvAt(F.cur, dayForLookup, chosenEntryH) || getIvAt(F.n2n, d, chosenEntryH) || getIvAt(F.cur, d, chosenEntryH);
      if (!iv0 || iv0 < 10 || iv0 > 150) {
        iv0 = getIvAt(F.n2n, d, baseEntryH) || getIvAt(F.cur, d, baseEntryH);
        if (!iv0 || iv0 < 10 || iv0 > 150) continue;
      }

      let deltaC = (F.dow === 5 || iv0 < 28) ? 0.11 : 0.15;
      let deltaP = (F.dow === 5 || iv0 < 28) ? 0.11 : 0.15;

      const T0 = yrs(F.settle - chosenEntryH);
      const Kc = strike(b0.c, T0, iv0, deltaC, 'c');
      const Kp = strike(b0.c, T0, iv0, deltaP, 'p');
      const c0 = bs(b0.c, Kc, T0, iv0, 'c');
      const p0 = bs(b0.c, Kp, T0, iv0, 'p');
      const cr = c0 + p0;

      let stopped = false;
      let finalClose = b0.c;
      const exitH = Math.floor(F.exit / HR) * HR; // 07:00 IST

      for (let t = chosenEntryH + HR; t <= exitH; t += HR) {
        const b = btcMap.get(t);
        if (!b) continue;
        finalClose = b.c;

        const dayForT = t < d0(nextDayStr) ? d : nextDayStr;
        let liveIv = getIvAt(F.n2n, dayForT, t) || getIvAt(F.cur, dayForT, t) || iv0 * 0.95;
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

      trades++;
      totalCredit += cr;
      if (stopped) {
        stops++;
        stressPnl += -cr * size;
        prodPnl += -260 * size;
      } else {
        wins++;
        const remT = yrs(F.settle - exitH);
        const exitIv = getIvAt(F.n2n, nextDayStr, exitH) || iv0 * 0.92;
        const cFin = bs(finalClose, Kc, remT, exitIv, 'c');
        const pFin = bs(finalClose, Kp, remT, exitIv, 'p');
        stressPnl += (cr - cFin - pFin) * size;
        prodPnl += 162.5 * size;
      }
    }

    return {
      trades,
      wins,
      stops,
      skipped,
      delayedEntries,
      prodPnl: Math.round(prodPnl),
      stressPnl: Math.round(stressPnl),
      avgCredit: trades > 0 ? Math.round(totalCredit / trades) : 0,
    };
  }

  console.log('\n================================================================================');
  console.log('  DELAYED ENTRY BACKTEST COMPARISON (REAL 269 SESSIONS)');
  console.log('================================================================================');

  const resStd = simulateTiming('std', false);
  console.log(`\n1. BASELINE PROVEN (NY+180m / 22:30 IST):`);
  console.log(`   Trades: ${resStd.trades} | Wins: ${resStd.wins} (${(resStd.wins/resStd.trades*100).toFixed(1)}%) | Stops: ${resStd.stops} (${(resStd.stops/resStd.trades*100).toFixed(1)}%) | Skipped: ${resStd.skipped}`);
  console.log(`   Avg Credit Collected: $${resStd.avgCredit} | Prod Net P&L: +$${resStd.prodPnl}`);

  const resDynNyClose = simulateTiming('dyn_delay_ny_close', false);
  console.log(`\n2. DYNAMIC DELAY UP TO NY CLOSE (01:30 / 02:30 IST on Weekdays):`);
  console.log(`   (If Speed >= 1.5x at 22:30, wait up to NY Close for speed to drop < 1.5x)`);
  console.log(`   Trades: ${resDynNyClose.trades} (+${resDynNyClose.delayedEntries} saved from speed skip) | Wins: ${resDynNyClose.wins} (${(resDynNyClose.wins/resDynNyClose.trades*100).toFixed(1)}%) | Stops: ${resDynNyClose.stops} (${(resDynNyClose.stops/resDynNyClose.trades*100).toFixed(1)}%) | Skipped: ${resDynNyClose.skipped}`);
  console.log(`   Avg Credit Collected: $${resDynNyClose.avgCredit} | Prod Net P&L: +$${resDynNyClose.prodPnl}`);

  const resDyn3am = simulateTiming('dyn_delay_3am', true);
  console.log(`\n3. DYNAMIC DELAY UP TO 03:00 IST (Including Weekends up to 3am):`);
  console.log(`   Trades: ${resDyn3am.trades} (+${resDyn3am.delayedEntries} saved from speed skip) | Wins: ${resDyn3am.wins} (${(resDyn3am.wins/resDyn3am.trades*100).toFixed(1)}%) | Stops: ${resDyn3am.stops} (${(resDyn3am.stops/resDyn3am.trades*100).toFixed(1)}%) | Skipped: ${resDyn3am.skipped}`);
  console.log(`   Avg Credit Collected: $${resDyn3am.avgCredit} | Prod Net P&L: +$${resDyn3am.prodPnl}`);

  const resFixedNyClose = simulateTiming('fixed_ny_close', false);
  console.log(`\n4. FIXED DELAY AT NY CLOSE (Enter ONLY at 01:30 IST every night):`);
  console.log(`   Trades: ${resFixedNyClose.trades} | Wins: ${resFixedNyClose.wins} (${(resFixedNyClose.wins/resFixedNyClose.trades*100).toFixed(1)}%) | Stops: ${resFixedNyClose.stops} (${(resFixedNyClose.stops/resFixedNyClose.trades*100).toFixed(1)}%)`);
  console.log(`   Avg Credit Collected: $${resFixedNyClose.avgCredit} (Theta already degraded!) | Prod Net P&L: +$${resFixedNyClose.prodPnl}`);

  const resFixed3am = simulateTiming('fixed_3am', false);
  console.log(`\n5. FIXED ULTRA-LATE AT 03:00 IST (Enter at 3am IST):`);
  console.log(`   Trades: ${resFixed3am.trades} | Wins: ${resFixed3am.wins} (${(resFixed3am.wins/resFixed3am.trades*100).toFixed(1)}%) | Stops: ${resFixed3am.stops} (${(resFixed3am.stops/resFixed3am.trades*100).toFixed(1)}%)`);
  console.log(`   Avg Credit Collected: $${resFixed3am.avgCredit} | Prod Net P&L: +$${resFixed3am.prodPnl}`);
}

runBacktest().catch(console.error);
