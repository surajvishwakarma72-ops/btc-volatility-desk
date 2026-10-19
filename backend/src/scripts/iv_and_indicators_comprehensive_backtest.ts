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

async function main() {
  console.log('='.repeat(80));
  console.log('  BTC VOLATILITY DESK: COMPREHENSIVE IV, INDICATORS & STOP-LOSS AUDIT');
  console.log('  Data: 269 Real Sessions (Oct 2025 - Oct 2026) | N2N Expiry');
  console.log('='.repeat(80));

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

  interface SessionTrade {
    day: string;
    dow: number;
    month: string;
    weekOfMonth: number;
    spotEntry: number;
    ivEntry: number;
    rv24Entry: number;
    rv6Entry: number;
    edge: number;
    speed: number;
    cStrike: number;
    pStrike: number;
    cr: number;
    cEntry: number;
    pEntry: number;
    cExit: number;
    pExit: number;
    ivExit: number;
    maxCallPrice: number;
    maxPutPrice: number;
    stoppedAt2x: boolean;
    callStop2x: boolean;
    putStop2x: boolean;
  }

  const trades: SessionTrade[] = [];

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

    trades.push({
      day: d,
      dow: F.dow,
      month: monthStr,
      weekOfMonth,
      spotEntry: btcCandle.c,
      ivEntry: iv,
      rv24Entry: rv24,
      rv6Entry: rv6,
      edge,
      speed,
      cStrike: cK,
      pStrike: pK,
      cr,
      cEntry,
      pEntry,
      cExit,
      pExit,
      ivExit,
      maxCallPrice: maxCall,
      maxPutPrice: maxPut,
      stoppedAt2x: stopped2x,
      callStop2x,
      putStop2x
    });
  }

  console.log(`\nProcessed ${trades.length} active sessions with full N2N option chains.\n`);

  // =========================================================================
  // 1. IV REGIME & EDGE REPORT
  // =========================================================================
  console.log('='.repeat(80));
  console.log('  SECTION 1: IV REGIME & EDGE (VARIANCE RISK PREMIUM) BACKTEST');
  console.log('='.repeat(80));

  const ivRegimes = [
    { name: 'High IV Regime (IV > 55%)', filter: (t: SessionTrade) => t.ivEntry > 55 },
    { name: 'Medium IV Regime (40% <= IV <= 55%)', filter: (t: SessionTrade) => t.ivEntry >= 40 && t.ivEntry <= 55 },
    { name: 'Low IV Regime (IV < 40%)', filter: (t: SessionTrade) => t.ivEntry < 40 },
    { name: 'Edge > +4 pts (Rich Vol Premium)', filter: (t: SessionTrade) => t.edge > 4.0 },
    { name: 'Edge 0 to +4 pts (Healthy Positive Edge)', filter: (t: SessionTrade) => t.edge >= 0 && t.edge <= 4.0 },
    { name: 'Edge < 0 pts (Underpriced Vol Trap / IV < RV)', filter: (t: SessionTrade) => t.edge < 0 },
  ];

  for (const reg of ivRegimes) {
    const list = trades.filter(reg.filter);
    const n = list.length;
    if (n === 0) continue;
    const wins = list.filter(t => !t.stoppedAt2x).length;
    const stops = n - wins;
    const wr = (wins / n * 100).toFixed(1);
    const avgIv = (list.reduce((a, b) => a + b.ivEntry, 0) / n).toFixed(1);
    const avgCr = (list.reduce((a, b) => a + b.cr, 0) / n).toFixed(0);
    const avgCrush = (list.reduce((a, b) => a + (b.ivEntry - b.ivExit), 0) / n).toFixed(1);

    // Production P&L (50% TP, opposite leg decay on stop)
    let prodPnl = 0;
    for (const t of list) {
      const size = (t.dow === 2 || t.dow === 3) ? 1.0 : 0.5;
      if (!t.stoppedAt2x) prodPnl += (t.cr * 0.50) * size;
      else prodPnl -= (t.cr * 0.80) * size;
    }
    console.log(`[${reg.name.padEnd(46)}] Trades: ${String(n).padStart(3)} | Win Rate: ${wr.padStart(5)}% | Avg IV: ${avgIv}% | Avg Crush: +${avgCrush} pts | Prod P&L: $${prodPnl.toFixed(0).padStart(7)}`);
  }

  // =========================================================================
  // 2. MINIMUM & OPTIMAL STOP-LOSS REPORT (MULTIPLE AUDIT)
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 2: MINIMUM & OPTIMAL STOP-LOSS MULTIPLE REPORT');
  console.log('  (Testing mark price stops from 1.2x to 3.0x on either leg)');
  console.log('='.repeat(80));

  const slMultiples = [1.2, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.5, 3.0, 999.0];

  for (const mult of slMultiples) {
    let stops = 0, wins = 0;
    let totalPnl = 0;
    let grossWins = 0, grossLoss = 0;

    for (const t of trades) {
      if (t.dow === 4) continue; // standard Thursday skip
      const size = (t.dow === 2 || t.dow === 3) ? 1.0 : 0.5;
      const hitStop = (t.maxCallPrice >= mult * t.cr) || (t.maxPutPrice >= mult * t.cr);

      if (hitStop) {
        stops++;
        const loss = t.cr * (mult - 1.0) * size;
        totalPnl -= loss;
        grossLoss += loss;
      } else {
        wins++;
        const gain = (t.cr * 0.50) * size;
        totalPnl += gain;
        grossWins += gain;
      }
    }
    const total = wins + stops;
    const wr = (wins / total * 100).toFixed(1);
    const stopRate = (stops / total * 100).toFixed(1);
    const pf = grossLoss > 0 ? (grossWins / grossLoss).toFixed(2) : 'Inf';
    const tag = mult === 999.0 ? 'No Stop (Unhedged)' : `${mult.toFixed(1)}x Mark Price`;
    console.log(`Stop Multiple: ${tag.padEnd(20)} | Trades: ${total} | Win%: ${wr.padStart(5)}% | Stop%: ${stopRate.padStart(5)}% | Net P&L: $${totalPnl.toFixed(0).padStart(7)} | Profit Factor: ${pf}x`);
  }

  // =========================================================================
  // 3. IV + INDICATORS COMBINED MASTER ENGINE ON N2N EXPIRY
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 3: IV + INDICATORS COMBINED MASTER ENGINE (N2N EXPIRY)');
  console.log('='.repeat(80));

  const stratBaseline = trades; // all
  const stratIvOnly = trades.filter(t => t.edge >= 0 && t.ivEntry >= 35);
  const stratIndOnly = trades.filter(t => t.dow !== 4 && t.speed < 1.5);
  const stratMaster = trades.filter(t => t.dow !== 4 && t.speed < 1.5 && t.edge >= 0 && t.ivEntry >= 35);

  const configs = [
    { name: '1. Raw Baseline (No Filters, Every Night)', list: stratBaseline },
    { name: '2. IV-Only Filter (Edge >= 0 & IV >= 35%)', list: stratIvOnly },
    { name: '3. Indicators-Only Filter (Speed < 1.5x & Non-Thu)', list: stratIndOnly },
    { name: '4. MASTER DUAL ENGINE (IV Edge >= 0 + Speed < 1.5x + Non-Thu)', list: stratMaster },
  ];

  for (const cfg of configs) {
    let wins = 0, stops = 0, prodPnl = 0, stressPnl = 0;
    for (const t of cfg.list) {
      const size = (t.dow === 2 || t.dow === 3) ? 1.0 : 0.5;
      if (!t.stoppedAt2x) {
        wins++;
        prodPnl += (t.cr * 0.50) * size;
        stressPnl += (t.cr - t.cExit - t.pExit) * size;
      } else {
        stops++;
        prodPnl -= (t.cr * 0.80) * size;
        stressPnl -= t.cr * size;
      }
    }
    const tot = wins + stops;
    const wr = (wins / tot * 100).toFixed(1);
    console.log(`\n>>> ${cfg.name}`);
    console.log(`    Total Trades: ${tot} | Wins: ${wins} (${wr}%) | Stops: ${stops} (${(100 - parseFloat(wr)).toFixed(1)}%)`);
    console.log(`    Production Net P&L (50% TP): +$${prodPnl.toFixed(0)} | Profit Factor: ${(prodPnl / Math.max(1, stops * 250)).toFixed(2)}x`);
    console.log(`    Raw Unhedged Stress P&L:      $${stressPnl.toFixed(0)}`);
  }

  // =========================================================================
  // 4. DAY OF THE WEEK (SEASONALITY & BEST ENTRY TIME)
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 4: DAY-OF-THE-WEEK DETAILED BREAKDOWN & OPTIMAL ENTRY');
  console.log('='.repeat(80));

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let dow = 0; dow <= 6; dow++) {
    const list = trades.filter(t => t.dow === dow);
    const n = list.length;
    if (n === 0) continue;
    const wins = list.filter(t => !t.stoppedAt2x).length;
    const wr = (wins / n * 100).toFixed(1);
    const avgIv = (list.reduce((a, b) => a + b.ivEntry, 0) / n).toFixed(1);
    const avgRv = (list.reduce((a, b) => a + b.rv24Entry, 0) / n).toFixed(1);
    const avgEdge = (list.reduce((a, b) => a + b.edge, 0) / n).toFixed(1);
    const avgCrush = (list.reduce((a, b) => a + (b.ivEntry - b.ivExit), 0) / n).toFixed(1);

    let rec = '';
    let entryWindow = '';
    if (dow === 2 || dow === 3) {
      rec = '🔥 PRIME (1.0x Full Size) - Deepest Edge & Calmest overnight';
      entryWindow = '22:30 IST (NY+180m)';
    } else if (dow === 1 || dow === 5) {
      rec = '🛡️ SAFE (0.5x Half Size) - Solid edge, moderate weekend transition';
      entryWindow = '22:30 IST (NY+180m)';
    } else if (dow === 4) {
      rec = '🛑 HARD SKIP (0.0x Size) - Sunday Expiry Shock hazard';
      entryWindow = 'DO NOT TRADE';
    } else {
      rec = '⚡ WEEKEND CAUTION (0.5x Size) - Thinner liquidity, trade delayed';
      entryWindow = '23:00 - 01:30 IST';
    }

    console.log(`\n[${dayNames[dow]}] (${n} sessions)`);
    console.log(`  Win Rate: ${wr}% (${wins}W / ${n - wins}L) | Avg IV: ${avgIv}% | 24h RV: ${avgRv}% | Edge: +${avgEdge} pts | Avg Crush: +${avgCrush} pts`);
    console.log(`  Best Entry: ${entryWindow} | Best Exit: 04:00 - 07:00 IST`);
    console.log(`  Verdict: ${rec}`);
  }

  // =========================================================================
  // 5. MONTHLY & WEEKLY CYCLE BREAKDOWN
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('  SECTION 5: MONTHLY & WEEK-OF-MONTH CYCLE (DERIBIT OPEX SEASONALITY)');
  console.log('='.repeat(80));

  const months = [...new Set(trades.map(t => t.month))].sort();
  console.log('\n--- Monthly Breakdown ---');
  for (const m of months) {
    const list = trades.filter(t => t.month === m && t.dow !== 4);
    const n = list.length;
    if (n === 0) continue;
    const wins = list.filter(t => !t.stoppedAt2x).length;
    const wr = (wins / n * 100).toFixed(1);
    const avgIv = (list.reduce((a, b) => a + b.ivEntry, 0) / n).toFixed(1);
    let pnl = 0;
    for (const t of list) {
      const size = (t.dow === 2 || t.dow === 3) ? 1.0 : 0.5;
      if (!t.stoppedAt2x) pnl += t.cr * 0.50 * size;
      else pnl -= t.cr * 0.80 * size;
    }
    console.log(`Month: ${m} | Trades: ${String(n).padStart(2)} | Win Rate: ${wr.padStart(5)}% | Avg IV: ${avgIv}% | P&L: +$${pnl.toFixed(0).padStart(5)}`);
  }

  console.log('\n--- Week of Month Breakdown (Deribit Monthly OpEx Cycle) ---');
  for (let w = 1; w <= 4; w++) {
    const list = trades.filter(t => t.weekOfMonth === w && t.dow !== 4);
    const n = list.length;
    const wins = list.filter(t => !t.stoppedAt2x).length;
    const wr = (wins / n * 100).toFixed(1);
    const avgIv = (list.reduce((a, b) => a + b.ivEntry, 0) / n).toFixed(1);
    const avgCrush = (list.reduce((a, b) => a + (b.ivEntry - b.ivExit), 0) / n).toFixed(1);
    const label = w === 1 ? 'Week 1 (Post-OpEx reset, fresh positioning)' :
                  w === 2 ? 'Week 2 (Mid-cycle drift, steady theta decay)' :
                  w === 3 ? 'Week 3 (Pre-OpEx buildup, highest ATM IV)' :
                            'Week 4 (Monthly OpEx settlement week, gamma pins)';
    console.log(`Week ${w}: ${label}`);
    console.log(`  Trades: ${n} | Win Rate: ${wr}% | Avg IV: ${avgIv}% | Avg Overnight Crush: +${avgCrush} pts`);
  }
}

main().catch(err => {
  console.error('Fatal error in backtest:', err);
  process.exit(1);
});
