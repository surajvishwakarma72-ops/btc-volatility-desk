/**
 * WEEKDAY PATTERNS — what does each weekday CONSISTENTLY do in the data, so the calendar can alert
 * the upcoming one ("today is Wednesday → Wednesdays tend to X → watch for Y"). Per weekday:
 *   IV-fall reliability, avg IV at entry, best entry hour, stop rate, which leg usually breaks,
 *   typical BTC move, and a one-line observed pattern.
 * Run: npx tsx src/backtest/steps/weekday_patterns.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

function main() {
  const data = loadData();
  type Rec = { iv0: number; stopped: boolean; win: boolean; leg: string; move: number; hadTurn: boolean; entH: number };
  const byDow: Record<number, Rec[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  // entry-hour sweep per weekday (fixed-time entry) to find best hour
  const hourStat: Record<number, Record<number, { s: number; n: number; pnl: number }>> = {};
  for (const d of [1, 2, 3, 4, 5]) { hourStat[d] = {}; for (let h = 19; h <= 26; h++) hourStat[d][h] = { s: 0, n: 0, pnl: 0 }; }

  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const f = frame(d0(dk(dayMs + 12 * HR)) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    const hadTurn = sLab.hasEvent;
    const entryT = hadTurn ? turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0) : null;
    if (entryT != null) {
      const iv0 = data.ivAt(f.n2n, entryT);
      const s = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: 2.0, targetPct: 0.12 });
      if (iv0 != null && s.ok) byDow[f.dow].push({ iv0, stopped: s.stopped, win: s.pnlPctMargin > 0, leg: (s.hurtLeg || 'none').toLowerCase(), move: s.btcMovePct, hadTurn, entH: Math.round((entryT - f.D0) / HR) });
    }
    for (let h = 19; h <= 26; h++) {
      const t = f.D0 + h * HR; if (t >= f.exit) continue;
      const iv = data.ivAt(f.n2n, t); if (iv == null) continue;
      const s = simulateStrangle(data, f, t, { ...DEFAULT_SIM, stopMult: 2.0, targetPct: 0.12 });
      if (s.ok) { const hs = hourStat[f.dow][h]; hs.n++; hs.pnl += s.pnlPctMargin; if (s.stopped) hs.s++; }
    }
  }

  console.log('='.repeat(100));
  console.log('WEEKDAY PATTERNS — the recurring behaviour the calendar should alert on (strict 2×, IV-turn entry)');
  console.log('='.repeat(100));
  console.log('  day   n   IVfall%  avgIV  stop%  win%  hurtLeg  avgMove%  bestEntry(IST)');
  for (const d of [1, 2, 3, 4, 5]) {
    const r = byDow[d]; if (!r.length) continue;
    const putBreak = r.filter((x) => x.leg === 'put').length, callBreak = r.filter((x) => x.leg === 'call').length;
    const leg = putBreak > callBreak ? `put(${putBreak})` : `call(${callBreak})`;
    // best entry hour = lowest stop with n>=10
    let best = 22, bestStop = 999;
    for (let h = 19; h <= 26; h++) { const hs = hourStat[d][h]; if (hs.n >= 10 && pct(hs.s, hs.n) < bestStop) { bestStop = pct(hs.s, hs.n); best = h; } }
    console.log(`  ${DOW[d]}  ${String(r.length).padStart(2)}   ${f1(pct(r.filter((x) => x.hadTurn).length, r.length)).padStart(5)}  ${f1(mean(r.map((x) => x.iv0))).padStart(5)}  ${f1(pct(r.filter((x) => x.stopped).length, r.length)).padStart(5)}  ${f1(pct(r.filter((x) => x.win).length, r.length)).padStart(5)}  ${leg.padEnd(8)}  ${f1(mean(r.map((x) => x.move))).padStart(6)}   ${String(best % 24).padStart(2, '0')}:00 (${f1(bestStop)}% stop)`);
  }

  console.log('\n  One-line observed pattern per weekday (for the calendar alert):');
  const notes: Record<number, string> = {
    1: 'Monday — weekend gap risk; highest stops, put-side breaks. Alert: smallest/strictest setup, wait late.',
    2: 'Tuesday — cleanest early-week crush; reliable IV fall. Alert: your best standard night.',
    3: 'Wednesday — mid-week; watch the US session move before selling. Alert: enter after the move settles.',
    4: 'Thursday — thin/variable; gate rarely opens. Alert: only the A+ setup, else skip.',
    5: 'Friday — premium weekend crush; enter late (~23:00). Alert: biggest edge but time the entry.',
  };
  for (const d of [1, 2, 3, 4, 5]) console.log('     ' + notes[d]);
  console.log('\n  (These notes are a starting read — adjust to whatever the table above actually shows.)');

  // Emit the per-weekday pattern data the calendar reads for its alive, predictive cards.
  const out: Record<string, any> = {};
  for (const d of [1, 2, 3, 4, 5]) {
    const r = byDow[d]; if (!r.length) continue;
    const put = r.filter((x) => x.leg === 'put').length, call = r.filter((x) => x.leg === 'call').length;
    const hurtLeg = call >= put ? 'call' : 'put';
    let bestH = 22, bestStop = 999;
    for (let h = 19; h <= 26; h++) { const hs = hourStat[d][h]; if (hs.n >= 10 && pct(hs.s, hs.n) < bestStop) { bestStop = pct(hs.s, hs.n); bestH = h; } }
    const avgIV = +mean(r.map((x) => x.iv0)).toFixed(1), stop = +pct(r.filter((x) => x.stopped).length, r.length).toFixed(1);
    const win = +pct(r.filter((x) => x.win).length, r.length).toFixed(1), avgMove = +mean(r.map((x) => x.move)).toFixed(1);
    const bestEntry = `${String(bestH % 24).padStart(2, '0')}:00`;
    out[DOW[d]] = {
      n: r.length, avgIV, stop, win, hurtLeg, avgMove, bestEntry, bestEntryStop: +bestStop.toFixed(1),
      note: `${DOW[d]}: IV averages ${avgIV}, ~${stop}% stop; the ${hurtLeg.toUpperCase()} leg usually breaks (price ${hurtLeg === 'call' ? 'rallies' : 'drops'} overnight). Best entry ~${bestEntry} IST (${bestStop.toFixed(0)}% stop vs ${stop.toFixed(0)}% at the turn). Watch the ${hurtLeg} side.`,
    };
  }
  const feDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data');
  fs.mkdirSync(feDir, { recursive: true });
  fs.writeFileSync(path.join(feDir, 'weekday_patterns.js'), `window.__STRANGLE_WEEKDAY = ${JSON.stringify(out)};\n`);
  console.log(`\n[weekday_patterns] wrote frontend/public/data/weekday_patterns.js (window.__STRANGLE_WEEKDAY).`);
}

main();
