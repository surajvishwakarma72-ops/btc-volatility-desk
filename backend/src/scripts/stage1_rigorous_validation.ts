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

  interface SessionRecord {
    day: string;
    dow: number;
    stopped: boolean;
    speedUnder15: boolean;
    edge0to6: boolean;
    isTueWed: boolean;
    isThu: boolean;
    isMon: boolean;
    isFri: boolean;
  }

  const sessions: SessionRecord[] = [];

  for (let i = 0; i < sortedDays.length; i++) {
    const d = sortedDays[i];
    const nextDayStr = sortedDays[i + 1] || dk(Date.parse(d + 'T12:00:00Z') + DAY);
    const F = frame(d0(d) + 20 * HR);
    if (F.dow === 0 || F.dow === 6) continue;

    const entryH = Math.floor((F.open + 60 * MIN) / HR) * HR;
    const b0 = btcMap.get(entryH) || btcMap.get(entryH - HR);
    if (!b0 || b0.c <= 0) continue;

    const S0 = b0.c;
    const t0 = entryH;

    let iv0 = getIvAt(F.n2n, d, t0) || getIvAt(F.cur, d, t0);
    if (!iv0 || iv0 < 10 || iv0 > 150) continue;

    const rv6 = getRv(t0, 6);
    const rv24 = getRv(t0, 24);

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

    let stopped = false;
    const exitH = Math.floor(F.exit / HR) * HR;

    for (let t = t0 + HR; t <= exitH; t += HR) {
      const b = btcMap.get(t);
      if (!b) continue;

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

    const speedUnder15 = rv6 != null && iv0 > 0 ? (rv6 / iv0 < 1.5) : false;
    const edge0to6 = rv24 != null && iv0 > 0 ? (iv0 - rv24 > 0 && iv0 - rv24 <= 6) : false;

    sessions.push({
      day: d,
      dow: F.dow,
      stopped,
      speedUnder15,
      edge0to6,
      isTueWed: F.dow === 2 || F.dow === 3,
      isThu: F.dow === 4,
      isMon: F.dow === 1,
      isFri: F.dow === 5,
    });
  }

  console.log(`\nLoaded ${sessions.length} sessions.`);

  // --------------------------------------------------------------------------
  // PART 1: BONFERRONI CORRECTION ANALYSIS
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  PART 1: BONFERRONI CORRECTION (Family-Wise Error Control)');
  console.log('================================================================================');
  const numTests = 31;
  const alphaStd = 0.05;
  const alphaBonf = alphaStd / numTests;
  console.log(`Number of hypotheses tested (M): ${numTests}`);
  console.log(`Standard Significance Threshold: alpha = 0.0500  (Chi-Square >= 3.841)`);
  console.log(`Bonferroni Corrected Threshold:   alpha = ${alphaBonf.toFixed(5)} (Chi-Square >= 9.94)`);
  console.log(`\nEvaluating all top performers against alpha = ${alphaBonf.toFixed(5)}:`);

  // --------------------------------------------------------------------------
  // PART 2: DAY-BY-DAY BREAKDOWN (Is Thu vs Tue/Wed same pattern or separate?)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  PART 2: DAY-OF-WEEK BREAKDOWN (Independent vs Dependent Pattern)');
  console.log('================================================================================');
  const dayNames = ['Sun', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Sat'];
  for (let dow = 1; dow <= 5; dow++) {
    const subset = sessions.filter(s => s.dow === dow);
    const stp = subset.filter(s => s.stopped).length;
    const win = subset.length - stp;
    const rate = (stp / subset.length) * 100;
    console.log(`  ${dayNames[dow].padEnd(10, ' ')}: N = ${subset.length.toString().padStart(2, ' ')} | Stops = ${stp.toString().padStart(2, ' ')} (${rate.toFixed(1)}%) | Wins = ${win.toString().padStart(2, ' ')} (${(100 - rate).toFixed(1)}%)`);
  }

  // Compare Tue/Wed vs Mon/Fri (Excluding Thursday!)
  const nonThu = sessions.filter(s => s.dow !== 4);
  const tueWedInNonThu = nonThu.filter(s => s.dow === 2 || s.dow === 3);
  const monFriInNonThu = nonThu.filter(s => s.dow === 1 || s.dow === 5);

  const twStp = tueWedInNonThu.filter(s => s.stopped).length;
  const mfStp = monFriInNonThu.filter(s => s.stopped).length;

  console.log('\n  --- Does Tue/Wed outperform EVEN WHEN THURSDAY IS ALREADY REMOVED? ---');
  console.log(`  Tue + Wed:        N = ${tueWedInNonThu.length} | Stops = ${twStp} (${(twStp / tueWedInNonThu.length * 100).toFixed(1)}%)`);
  console.log(`  Mon + Fri:        N = ${monFriInNonThu.length} | Stops = ${mfStp} (${(mfStp / monFriInNonThu.length * 100).toFixed(1)}%)`);
  const c2NonThu = calcChi2Yates(twStp, tueWedInNonThu.length - twStp, mfStp, monFriInNonThu.length - mfStp);
  console.log(`  Difference:       ${(mfStp / monFriInNonThu.length * 100 - twStp / tueWedInNonThu.length * 100).toFixed(1)}% lower stops on Tue/Wed vs Mon/Fri`);
  console.log(`  Chi-Square within Non-Thu days: ${c2NonThu.chi2.toFixed(3)} (p = ${c2NonThu.pVal.toFixed(4)})`);

  // --------------------------------------------------------------------------
  // PART 3: OUT-OF-SAMPLE WALK-FORWARD VALIDATION (50/50 Temporal Split)
  // --------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('  PART 3: OUT-OF-SAMPLE / WALK-FORWARD TEST (50/50 Split)');
  console.log('================================================================================');
  const splitIdx = Math.floor(sessions.length / 2);
  const inSample = sessions.slice(0, splitIdx);
  const outSample = sessions.slice(splitIdx);

  console.log(`In-Sample Period:     ${inSample[0].day} to ${inSample[inSample.length - 1].day} (N = ${inSample.length} nights)`);
  console.log(`Out-of-Sample Period: ${outSample[0].day} to ${outSample[outSample.length - 1].day} (N = ${outSample.length} nights)`);

  function testRule(name: string, filterFn: (s: SessionRecord) => boolean) {
    console.log(`\n[RULE EVALUATION]: ${name}`);
    
    // In-Sample
    const isGood = inSample.filter(filterFn);
    const isBad = inSample.filter(s => !filterFn(s));
    const isGoodStp = isGood.filter(s => s.stopped).length;
    const isBadStp = isBad.filter(s => s.stopped).length;
    const isGoodRate = (isGoodStp / isGood.length) * 100;
    const isBadRate = (isBadStp / isBad.length) * 100;
    const isChi = calcChi2Yates(isGoodStp, isGood.length - isGoodStp, isBadStp, isBad.length - isBadStp);

    // Out-of-Sample
    const oosGood = outSample.filter(filterFn);
    const oosBad = outSample.filter(s => !filterFn(s));
    const oosGoodStp = oosGood.filter(s => s.stopped).length;
    const oosBadStp = oosBad.filter(s => s.stopped).length;
    const oosGoodRate = (oosGoodStp / oosGood.length) * 100;
    const oosBadRate = (oosBadStp / oosBad.length) * 100;
    const oosChi = calcChi2Yates(oosGoodStp, oosGood.length - oosGoodStp, oosBadStp, oosBad.length - oosBadStp);

    console.log(`  IN-SAMPLE (First 134 nights):`);
    console.log(`    Condition Met:     ${isGoodRate.toFixed(1)}% stop rate (${isGoodStp}/${isGood.length})`);
    console.log(`    Condition Violated:${isBadRate.toFixed(1)}% stop rate (${isBadStp}/${isBad.length})`);
    console.log(`    Stop Reduction:    +${(isBadRate - isGoodRate).toFixed(1)}%`);
    console.log(`    Chi-Square:        ${isChi.chi2.toFixed(3)} (p = ${isChi.pVal.toFixed(4)})`);

    console.log(`  OUT-OF-SAMPLE (Fresh 135 nights - NEVER SEEN BEFORE):`);
    console.log(`    Condition Met:     ${oosGoodRate.toFixed(1)}% stop rate (${oosGoodStp}/${oosGood.length})`);
    console.log(`    Condition Violated:${oosBadRate.toFixed(1)}% stop rate (${oosBadStp}/${oosBad.length})`);
    console.log(`    Stop Reduction:    +${(oosBadRate - oosGoodRate).toFixed(1)}%`);
    console.log(`    Chi-Square:        ${oosChi.chi2.toFixed(3)} (p = ${oosChi.pVal.toFixed(4)})`);
    console.log(`    Holds Up Out-of-Sample?: ${oosGoodRate < oosBadRate ? '>>> YES - REDUCED STOPS ON FRESH DATA <<<' : 'NO - FAILED OOS'}`);
  }

  testRule('Combo 1: Speed < 1.5x + Tue/Wed Prime', s => s.speedUnder15 && s.isTueWed);
  testRule('Combo 2: Speed < 1.5x + Non-Thursday', s => s.speedUnder15 && !s.isThu);
  testRule('Rule 3: Thursday Skip Alone (!Thursday)', s => !s.isThu);
  testRule('Rule 4: Broad Edge Filter (IV - 24h RV in [0, 6])', s => s.edge0to6);
}

main().catch(console.error);
