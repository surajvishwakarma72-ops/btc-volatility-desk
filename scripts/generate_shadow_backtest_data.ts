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
  return {
    base,
    D0,
    edt,
    open,
    end: open + 7.5 * HR,
    exit: D0 + 31 * HR, // 07:00 IST morning
    settle: (base + 3) * DAY - IST + 17.5 * HR,
    listing: D0 + 17.5 * HR,
    dow: new Date(base * DAY).getUTCDay(),
    cur: keyOf(base + 1),
    nxt: keyOf(base + 2),
    n2n: keyOf(base + 3),
  };
}

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function buildShadowData() {
  console.log('Generating comprehensive shadow-mode backtest dataset...');

  const dexCandles: any[] = JSON.parse(fs.readFileSync('backend/dexbtusd_1year.json', 'utf-8'));
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

  const exportRaw = fs.readFileSync('backend/browser-data-export.json', 'utf-8');
  const bundle = JSON.parse(exportRaw);
  const ivStore = bundle.indexedDB?.suraj_archive_v1?.stores?.iv || [];
  const ivDataMap = new Map<string, any>();
  for (const item of ivStore) {
    const v = item.value || item;
    if (v.e && v.day && v.c) ivDataMap.set(`${v.e}|${v.day}`, v.c);
  }

  function getIvAt(expiry: string, day: string, targetT: number): number | null {
    const cObj = ivDataMap.get(`${expiry}|${day}`);
    if (!cObj) return null;
    const dayStart = d0(day);
    const minute = Math.floor((targetT - dayStart) / MIN);
    if (minute < 0 || minute >= 1440) return null;
    const val = cObj[minute];
    if (Number.isFinite(val) && val > 0) return val < 5 ? val * 100 : val;
    for (let d = 1; d <= 60; d++) {
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

  const sessions: any[] = [];

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const F = frame(d0(d) + 20 * HR);
    const entryT = Math.floor((F.open + 180 * MIN) / HR) * HR; // 22:30 IST

    const btcCandle = btcMap.get(entryT);
    if (!btcCandle) continue;

    const iv = getIvAt(F.n2n, d, entryT) || getIvAt(F.cur, d, entryT);
    if (!iv) continue;

    const rv24 = getRv(entryT, 24) || iv;
    const rv6 = getRv(entryT, 6) || iv;
    const edge = iv - rv24;
    const speed = rv6 / iv;

    const T_entry = yrs(F.settle - entryT);
    const cK = strike(btcCandle.c, T_entry, iv, 0.15, 'c');
    const pK = strike(btcCandle.c, T_entry, iv, 0.15, 'p');

    const cEntry = bs(btcCandle.c, cK, T_entry, iv, 'c');
    const pEntry = bs(btcCandle.c, pK, T_entry, iv, 'p');
    const cr = cEntry + pEntry;

    // Track overnight trajectory up to 07:00 IST exit
    let maxCall = cEntry, maxPut = pEntry;
    let stopped2x = false, callStop2x = false, putStop2x = false;

    const nextDayStr = days[i + 1] || dk(Date.parse(d + 'T12:00:00Z') + DAY);

    for (let t = entryT + HR; t <= F.exit; t += HR) {
      const bAt = btcMap.get(t);
      if (!bAt) continue;
      const tDay = (t > d0(d) + 24 * HR) ? nextDayStr : d;
      const ivAt = getIvAt(F.n2n, tDay, t) || getIvAt(F.cur, tDay, t) || iv;
      const T_curr = yrs(F.settle - t);

      const cCurr = bs(bAt.h, cK, T_curr, ivAt, 'c');
      const pCurr = bs(bAt.l, pK, T_curr, ivAt, 'p');

      if (cCurr > maxCall) maxCall = cCurr;
      if (pCurr > maxPut) maxPut = pCurr;

      if (cCurr >= 2.0 * cr) { stopped2x = true; callStop2x = true; }
      if (pCurr >= 2.0 * cr) { stopped2x = true; putStop2x = true; }
    }

    const bExit = btcMap.get(F.exit) || btcCandle;
    const ivExit = getIvAt(F.n2n, nextDayStr, F.exit) || getIvAt(F.cur, nextDayStr, F.exit) || iv;
    const T_exit = yrs(F.settle - F.exit);
    const cExit = bs(bExit.c, cK, T_exit, ivExit, 'c');
    const pExit = bs(bExit.c, pK, T_exit, ivExit, 'p');

    const dateObj = new Date(d);
    const monthStr = dateObj.toISOString().slice(0, 7);
    const dayOfMonth = dateObj.getUTCDate();
    const weekOfMonth = Math.min(4, Math.floor((dayOfMonth - 1) / 7) + 1);

    // Baseline Strategy (Trade weekdays, skip Thu)
    const baselineAction = (F.dow === 4) ? 'SKIP' : 'TRADE';
    const baselineSize = (F.dow === 2 || F.dow === 3) ? 1.0 : (F.dow === 4 ? 0.0 : 0.5);
    let baselinePnl = 0;
    if (baselineAction === 'TRADE') {
      if (!stopped2x) baselinePnl = Math.round(cr * 0.50 * baselineSize);
      else baselinePnl = -Math.round(cr * 0.80 * baselineSize);
    }

    // Speed Only Strategy
    const speedOnlyAction = (F.dow !== 4 && speed < 1.5) ? 'TRADE' : 'SKIP';
    const speedOnlySize = (F.dow === 2 || F.dow === 3) ? 1.0 : 0.5;
    let speedOnlyPnl = 0;
    if (speedOnlyAction === 'TRADE') {
      if (!stopped2x) speedOnlyPnl = Math.round(cr * 0.50 * speedOnlySize);
      else speedOnlyPnl = -Math.round(cr * 0.80 * speedOnlySize);
    }

    // IV Only Strategy
    const ivOnlyAction = (edge >= 0 && iv >= 35) ? 'TRADE' : 'SKIP';
    const ivOnlySize = (F.dow === 2 || F.dow === 3) ? 1.0 : 0.5;
    let ivOnlyPnl = 0;
    if (ivOnlyAction === 'TRADE') {
      if (!stopped2x) ivOnlyPnl = Math.round(cr * 0.50 * ivOnlySize);
      else ivOnlyPnl = -Math.round(cr * 0.80 * ivOnlySize);
    }

    // Master Dual-Engine Strategy (IV Edge >= 0 + Speed < 1.5x + ATM IV >= 35% + Non-Thu)
    const masterAction = (F.dow !== 4 && speed < 1.5 && edge >= 0 && iv >= 35) ? 'TRADE' : 'SKIP';
    const masterSize = (F.dow === 2 || F.dow === 3) ? 1.0 : 0.5;
    let masterPnl = 0;
    if (masterAction === 'TRADE') {
      if (!stopped2x) masterPnl = Math.round(cr * 0.50 * masterSize);
      else masterPnl = -Math.round(cr * 0.80 * masterSize);
    }

    // Economy State Determination
    let state = 'STABLE';
    if (speed >= 1.5 || iv > 60 || rv6 > 55) {
      state = 'STORM';
    } else if (btcCandle.c > btcCandle.o * 1.025) {
      state = 'INFLATION';
    } else if (btcCandle.c < btcCandle.o * 0.975) {
      state = 'CRISIS';
    } else if (Math.abs(btcCandle.h - btcCandle.l) > (btcCandle.c * 0.035)) {
      state = 'RUMOUR';
    }

    // Check ministers
    const minEdge = edge >= 0 ? 'PASS' : 'FAIL';
    const minSpeed = speed < 1.5 ? 'PASS' : 'WARN';
    const minIv = iv >= 35 ? 'PASS' : 'WARN';
    const minDow = F.dow === 4 ? 'SKIP' : 'PASS';
    const savedLoss = (stopped2x && masterAction === 'SKIP');

    let reason = '';
    if (masterAction === 'TRADE') {
      reason = `All systems GO. Edge +${edge.toFixed(1)} pts, Speed ${speed.toFixed(2)}x, IV ${iv.toFixed(1)}%.`;
    } else {
      const why: string[] = [];
      if (F.dow === 4) why.push('Thursday Sunday-Expiry Shock hazard');
      if (edge < 0) why.push(`Underpriced IV Trap (Edge ${edge.toFixed(1)} pts)`);
      if (speed >= 1.5) why.push(`Speed Breakout (${speed.toFixed(2)}x >= 1.5x)`);
      if (iv < 35) why.push(`ATM IV too low (${iv.toFixed(1)}% < 35%)`);
      reason = `Skipped: ${why.join('; ')}.`;
      if (savedLoss) reason += ` 🛡️ SAVED CAPITAL: Trade would have hit 2.0x SL!`;
    }

    sessions.push({
      day: d,
      dow: F.dow,
      dowName: dayNames[F.dow],
      month: monthStr,
      weekOfMonth,
      spot: Math.round(btcCandle.c),
      iv: Number(iv.toFixed(1)),
      rv24: Number(rv24.toFixed(1)),
      rv6: Number(rv6.toFixed(1)),
      edge: Number(edge.toFixed(1)),
      speed: Number(speed.toFixed(2)),
      cStrike: cK,
      pStrike: pK,
      cr: Math.round(cr),
      stoppedAt2x: stopped2x,
      callStop2x,
      putStop2x,
      baselineAction,
      baselinePnl,
      speedOnlyAction,
      speedOnlyPnl,
      ivOnlyAction,
      ivOnlyPnl,
      masterAction,
      masterSize: masterAction === 'TRADE' ? masterSize : 0,
      masterPnl,
      savedLoss,
      state,
      ministers: {
        edge: minEdge,
        speed: minSpeed,
        iv: minIv,
        dow: minDow,
      },
      reason
    });
  }

  // Pre-calculate aggregates
  function calcStats(list: any[], actionKey: string, pnlKey: string) {
    const executed = list.filter(s => s[actionKey] === 'TRADE');
    const tot = executed.length;
    if (tot === 0) return { trades: 0, wins: 0, stops: 0, winRate: '0.0%', pnl: 0, pf: '0.0' };
    const wins = executed.filter(s => !s.stoppedAt2x).length;
    const stops = tot - wins;
    const winRate = ((wins / tot) * 100).toFixed(1) + '%';
    const pnl = executed.reduce((a, b) => a + b[pnlKey], 0);
    const grossWins = executed.filter(s => !s.stoppedAt2x).reduce((a, b) => a + b[pnlKey], 0);
    const grossLoss = Math.abs(executed.filter(s => s.stoppedAt2x).reduce((a, b) => a + b[pnlKey], 0));
    const pf = grossLoss > 0 ? (grossWins / grossLoss).toFixed(2) : 'Inf';
    return { trades: tot, wins, stops, winRate, pnl, pf };
  }

  const aggregates = {
    baseline: calcStats(sessions, 'baselineAction', 'baselinePnl'),
    speedOnly: calcStats(sessions, 'speedOnlyAction', 'speedOnlyPnl'),
    ivOnly: calcStats(sessions, 'ivOnlyAction', 'ivOnlyPnl'),
    master: calcStats(sessions, 'masterAction', 'masterPnl'),
    savedLossCount: sessions.filter(s => s.savedLoss).length,
    totalSessions: sessions.length,
  };

  const output = {
    generatedAt: new Date().toISOString(),
    totalSessions: sessions.length,
    aggregates,
    sessions
  };

  fs.writeFileSync('frontend/data/shadow_backtest_dataset.json', JSON.stringify(output, null, 2));
  console.log(`Saved ${sessions.length} sessions to frontend/data/shadow_backtest_dataset.json!`);
  console.log(`Baseline: ${aggregates.baseline.trades} trades, ${aggregates.baseline.winRate} win, $${aggregates.baseline.pnl}`);
  console.log(`Master Dual-Engine: ${aggregates.master.trades} trades, ${aggregates.master.winRate} win, $${aggregates.master.pnl}`);
  console.log(`Saved Stopped Trades: ${aggregates.savedLossCount} sessions avoided 2.0x SL.`);
}

buildShadowData().catch(console.error);
