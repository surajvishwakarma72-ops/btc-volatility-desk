/**
 * SESSION-EVENT VOLATILITY — realised vol around the four boundaries in the trader's journey:
 *   🌏 Asia open · 🇬🇧 London close · 🔔 CME settle · 🇺🇸 New York close  (all IST).
 *
 * For each day we measure annualised realised vol (from 1m log-returns) in a ±30m window around
 * each event, then aggregate by day-of-week / week-of-month / month. The point:
 *   • which event spikes vol, and WHEN (so the calendar/journey can warn),
 *   • NY-close + CME-settle land INSIDE the overnight hold → that's where the 2× stops come from,
 *   • "how to save yourself" = timing rules around the high-vol events (no skipping).
 *
 * Run: npx tsx src/backtest/steps/session_events.ts
 */
import { loadData } from '../data/load.js';
import { d0, dk, DAY, HR, MIN } from '../lib/frame.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ANN = Math.sqrt(525600); // minutes per year → annualise a 1m-return stdev
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

// The four journey events — IST hours from the session's local midnight (D0).
const EVENTS = [
  { id: 'asiaOpen', name: '🌏 Asia open', ist: 5.5 },      // Tokyo 09:00 JST
  { id: 'londonClose', name: '🇬🇧 London close', ist: 21.5 }, // ~16:00 London
  { id: 'cmeSettle', name: '🔔 CME settle', ist: 25.5 },    // 15:00 CT / 16:00 ET (next calendar day)
  { id: 'nyClose', name: '🇺🇸 New York close', ist: 25.5 }, // 16:00 ET equity close (next calendar day)
];

/** Annualised realised vol (%) from 1m closes in [fromMs, toMs]. */
function rvPct(data: any, fromMs: number, toMs: number): number {
  const bars = data.bars1mBetween(fromMs, toMs);
  if (bars.length < 5) return NaN;
  const r: number[] = [];
  for (let i = 1; i < bars.length; i++) if (bars[i - 1].c > 0 && bars[i].c > 0) r.push(Math.log(bars[i].c / bars[i - 1].c));
  if (r.length < 4) return NaN;
  const m = mean(r);
  const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
  return sd * ANN * 100;
}

function main() {
  const data = loadData();
  // Per event: collect {dow, wom, mon, rv} for each day.
  const rows: Record<string, { dow: number; wom: number; mon: number; rv: number }[]> = {};
  for (const e of EVENTS) rows[e.id] = [];
  // Also the overnight hold window (00:30–02:30 IST) vs the entry window (22:00–23:30 IST) per weekday.
  const holdRv: number[][] = Array.from({ length: 7 }, () => []);
  const entryRv: number[][] = Array.from({ length: 7 }, () => []);

  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const D0 = dayMs;
    const anchor = new Date(D0 + 12 * HR);
    const dow = anchor.getUTCDay(), wom = Math.min(5, Math.floor((anchor.getUTCDate() - 1) / 7) + 1), mon = anchor.getUTCMonth();
    for (const e of EVENTS) {
      const t = D0 + e.ist * HR;
      const rv = rvPct(data, t - 30 * MIN, t + 30 * MIN);
      if (Number.isFinite(rv)) rows[e.id].push({ dow, wom, mon, rv });
    }
    const hr = rvPct(data, D0 + 24.5 * HR, D0 + 26.5 * HR); // overnight hold core (contains NY close / CME settle)
    const er = rvPct(data, D0 + 22 * HR, D0 + 23.5 * HR);   // entry window
    if (Number.isFinite(hr)) holdRv[dow].push(hr);
    if (Number.isFinite(er)) entryRv[dow].push(er);
  }

  console.log('='.repeat(92));
  console.log('SESSION-EVENT VOLATILITY — annualised realised vol in ±30m around each event (IST)');
  console.log('='.repeat(92));

  // 1) Overall ranking.
  console.log('\n1) OVERALL — which event is most volatile:');
  console.log('  event               ~IST     n    avgRV%   maxRV%');
  const ranked = EVENTS.map((e) => {
    const rv = rows[e.id].map((x) => x.rv);
    return { e, n: rv.length, avg: mean(rv), max: Math.max(...rv) };
  }).sort((a, b) => b.avg - a.avg);
  for (const r of ranked) {
    const hm = `${String(Math.floor(r.e.ist) % 24).padStart(2, '0')}:${String(Math.round((r.e.ist % 1) * 60)).padStart(2, '0')}`;
    console.log(`  ${r.e.name.padEnd(18)} ${hm.padStart(5)}  ${String(r.n).padStart(3)}   ${f1(r.avg).padStart(6)}   ${f1(r.max).padStart(6)}`);
  }

  // 2) By day-of-week.
  console.log('\n2) BY DAY-OF-WEEK — avg event RV% (which weekday each event is calmest/wildest):');
  console.log('  event               Mon    Tue    Wed    Thu    Fri    Sat    Sun');
  for (const e of EVENTS) {
    const cells = [1, 2, 3, 4, 5, 6, 0].map((d) => f1(mean(rows[e.id].filter((x) => x.dow === d).map((x) => x.rv))).padStart(5));
    console.log(`  ${e.name.padEnd(18)} ${cells.join('  ')}`);
  }

  // 3) By week-of-month.
  console.log('\n3) BY WEEK-OF-MONTH — avg event RV%:');
  console.log('  event               W1     W2     W3     W4     W5');
  for (const e of EVENTS) {
    const cells = [1, 2, 3, 4, 5].map((w) => f1(mean(rows[e.id].filter((x) => x.wom === w).map((x) => x.rv))).padStart(5));
    console.log(`  ${e.name.padEnd(18)} ${cells.join('  ')}`);
  }

  // 4) By month.
  console.log('\n4) BY MONTH — avg event RV%:');
  const months = [...new Set(EVENTS.flatMap((e) => rows[e.id].map((x) => x.mon)))].sort((a, b) => a - b);
  console.log('  event              ' + months.map((m) => MON[m].padStart(6)).join(' '));
  for (const e of EVENTS) {
    const cells = months.map((m) => f1(mean(rows[e.id].filter((x) => x.mon === m).map((x) => x.rv))).padStart(6));
    console.log(`  ${e.name.padEnd(18)} ${cells.join(' ')}`);
  }

  // 5) The protection point — overnight hold window vs entry window (the stop-risk gap).
  console.log('\n5) HOW TO SAVE YOURSELF — overnight hold RV (00:30–02:30, contains NY close/CME settle) vs entry RV (22:00–23:30):');
  console.log('  weekday   entryRV%   holdRV%   hold−entry   (positive = price gets WILDER while you hold)');
  for (const d of [1, 2, 3, 4, 5]) {
    const er = mean(entryRv[d]), hr = mean(holdRv[d]);
    console.log(`  ${DOW[d].padEnd(8)}  ${f1(er).padStart(7)}   ${f1(hr).padStart(7)}   ${((hr - er >= 0 ? '+' : '') + f1(hr - er)).padStart(8)}`);
  }
  const erAll = mean([1, 2, 3, 4, 5].flatMap((d) => entryRv[d])), hrAll = mean([1, 2, 3, 4, 5].flatMap((d) => holdRv[d]));
  console.log(`\n  Across Mon–Fri: entry RV ${f1(erAll)}% → hold RV ${f1(hrAll)}%  (${((hrAll - erAll >= 0 ? '+' : '') + f1(hrAll - erAll))} pts).`);
  console.log('  PROTECTION (no skipping): by the time NY-close/CME-settle hit (~01:30 IST) you want to be');
  console.log('  already in profit and NEVER adding — these are the windows that trigger the 2× stop.');
}

main();
