/**
 * STEP 2 — IV-crush GENUINE-vs-FAKE classifier.
 *
 * For each night, find the NY-session IV spike, then label the post-peak path:
 *   CRUSH   = IV fell and did NOT re-rise before 07:00 (fake fear -> genuine crush -> sellable)
 *   REBOUND = IV fell then rose back (real fear -> should not have sold)
 * Enter at the crush trigger (first 15m after peak where IV fell >= 1.5 pts, within window)
 * and test which separators (Speed<1.5, IV<Clock, VoV-smooth) predict CRUSH, plus the
 * SL/win outcomes of entry combos and the too-early / too-late rates.
 *
 * Run: npx tsx src/backtest/steps/step2_ivcrush.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { rvAnnualizedPct, classifyCrush, crushEntryTrigger } from '../lib/signals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output');
const FIRST_DAY = '2025-10-06';
const LAST_DAY = '2026-10-17';
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

interface Row {
  day: string; dow: number; month: string;
  label: 'CRUSH' | 'REBOUND' | 'NO-EVENT';
  entered: boolean; entryIST: string;
  calm: boolean; belowClock: boolean; vovSmooth: boolean;
  outcome: string; stopped: boolean; pnlUsd: number; maeUsd: number;
  tooEarly: boolean; tooLate: boolean;
}

function main() {
  const data = loadData();
  const rows: Row[] = [];

  for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow === 0 || f.dow === 6) continue; // weekdays
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;

    const series = data.ivWindow(f.n2n, f.open, f.exit);
    const lab = classifyCrush(series, f.open, f.open + 3 * HR, f.exit);
    const month = day.slice(0, 7);

    if (!lab.hasEvent) {
      rows.push({ day, dow: f.dow, month, label: 'NO-EVENT', entered: false, entryIST: '', calm: false, belowClock: false, vovSmooth: false, outcome: '', stopped: false, pnlUsd: 0, maeUsd: 0, tooEarly: false, tooLate: false });
      continue;
    }

    const maxOff = f.dow === 5 ? 480 : 390;
    const windowEnd = f.open + maxOff * MIN;
    const entryT = crushEntryTrigger((t) => data.ivAt(f.n2n, t), lab.peakIv, lab.peakT, windowEnd);

    if (entryT == null) {
      rows.push({ day, dow: f.dow, month, label: lab.label, entered: false, entryIST: '', calm: false, belowClock: false, vovSmooth: false, outcome: 'NO-ENTRY', stopped: false, pnlUsd: 0, maeUsd: 0, tooEarly: false, tooLate: lab.troughT < f.open + maxOff * MIN });
      continue;
    }

    const ivNow = data.ivAt(f.n2n, entryT) ?? 0;
    const iv1h = data.ivAt(f.n2n, entryT - HR) ?? ivNow;
    const iv3h = data.ivAt(f.n2n, entryT - 3 * HR) ?? ivNow;
    const ivListing = data.ivAt(f.n2n, f.listing) ?? ivNow;
    const rv1h = rvAnnualizedPct(data.bars1mBetween(entryT - HR, entryT));
    const speed = rv1h != null && ivNow > 0 ? rv1h / ivNow : 99;

    const calm = speed < 1.5;
    const belowClock = ivNow < ivListing;
    const vovSmooth = ivNow < iv1h && Math.abs(ivNow - iv3h) < 1.5;

    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM);

    rows.push({
      day, dow: f.dow, month, label: lab.label, entered: sim.ok, entryIST: fmtIST(entryT, f.open),
      calm, belowClock, vovSmooth,
      outcome: sim.outcome, stopped: sim.stopped, pnlUsd: sim.pnlUsd, maeUsd: Math.abs(sim.maeUsd),
      tooEarly: lab.label === 'REBOUND', tooLate: entryT > lab.troughT,
    });
  }

  // Event census.
  const crush = rows.filter((r) => r.label === 'CRUSH').length;
  const rebound = rows.filter((r) => r.label === 'REBOUND').length;
  const noEvent = rows.filter((r) => r.label === 'NO-EVENT').length;
  console.log('='.repeat(70));
  console.log(`IV-CRUSH CENSUS (${rows.length} weekday nights)`);
  console.log(`  CRUSH (fell, no re-rise): ${crush}   REBOUND (re-rose): ${rebound}   NO-EVENT: ${noEvent}`);
  console.log(`  base rate P(CRUSH | event) = ${((crush / (crush + rebound)) * 100).toFixed(1)}%`);

  // Separator precision/recall for predicting CRUSH (among entered event nights).
  const ev = rows.filter((r) => r.entered && (r.label === 'CRUSH' || r.label === 'REBOUND'));
  console.log(`\nSEPARATOR SKILL for CRUSH (n=${ev.length} entered event nights):`);
  console.log('  signal           precision  recall   lift');
  const base = ev.filter((r) => r.label === 'CRUSH').length / ev.length;
  for (const [name, pred] of [
    ['Speed < 1.5', (r: Row) => r.calm],
    ['IV < Clock', (r: Row) => r.belowClock],
    ['VoV smooth', (r: Row) => r.vovSmooth],
    ['Speed & Clock', (r: Row) => r.calm && r.belowClock],
    ['all three', (r: Row) => r.calm && r.belowClock && r.vovSmooth],
  ] as [string, (r: Row) => boolean][]) {
    const on = ev.filter(pred);
    const tp = on.filter((r) => r.label === 'CRUSH').length;
    const precision = on.length ? (tp / on.length) * 100 : 0;
    const recall = (tp / ev.filter((r) => r.label === 'CRUSH').length) * 100;
    const lift = base > 0 ? precision / 100 / base : 0;
    console.log(`  ${name.padEnd(16)} ${precision.toFixed(1).padStart(8)}% ${recall.toFixed(1).padStart(6)}%  ${lift.toFixed(2).padStart(5)}x`);
  }

  // Entry-combo outcomes.
  console.log(`\nENTRY-COMBO OUTCOMES (entered event nights):`);
  console.log('  combo              n    SL%   win%   avgPnl$  avgMAE$  tooEarly%  tooLate%');
  for (const [name, pred] of [
    ['IV-fall only', () => true],
    ['+ Speed<1.5', (r: Row) => r.calm],
    ['+ IV<Clock', (r: Row) => r.belowClock],
    ['+ VoV smooth', (r: Row) => r.vovSmooth],
    ['+ Speed&Clock', (r: Row) => r.calm && r.belowClock],
    ['+ all three', (r: Row) => r.calm && r.belowClock && r.vovSmooth],
  ] as [string, (r: Row) => boolean][]) {
    const sub = ev.filter(pred);
    if (!sub.length) { console.log(`  ${name.padEnd(16)}   0`); continue; }
    const n = sub.length;
    const sl = sub.filter((r) => r.stopped).length;
    const win = sub.filter((r) => r.pnlUsd > 0).length;
    const te = sub.filter((r) => r.tooEarly).length;
    const tl = sub.filter((r) => r.tooLate).length;
    console.log(`  ${name.padEnd(16)} ${String(n).padStart(3)}  ${((sl / n) * 100).toFixed(1).padStart(4)}  ${((win / n) * 100).toFixed(1).padStart(5)}  ${mean(sub.map((r) => r.pnlUsd)).toFixed(2).padStart(7)}  ${mean(sub.map((r) => r.maeUsd)).toFixed(2).padStart(6)}  ${((te / n) * 100).toFixed(1).padStart(8)}  ${((tl / n) * 100).toFixed(1).padStart(7)}`);
  }

  // Month breakdown of clean crush rate.
  console.log(`\nCLEAN-CRUSH RATE BY MONTH (CRUSH / events):`);
  const months = [...new Set(rows.map((r) => r.month))].sort();
  for (const m of months) {
    const mr = rows.filter((r) => r.month === m && (r.label === 'CRUSH' || r.label === 'REBOUND'));
    if (!mr.length) continue;
    const c = mr.filter((r) => r.label === 'CRUSH').length;
    console.log(`  ${m}: ${((c / mr.length) * 100).toFixed(0).padStart(3)}%  (${c}/${mr.length})`);
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'step2_ivcrush.json');
  fs.writeFileSync(outPath, JSON.stringify({ census: { crush, rebound, noEvent }, rows }, null, 2));
  console.log(`\n[step2] wrote ${outPath}`);
}

function fmtIST(tMs: number, openMs: number): string {
  const offMin = Math.round((tMs - openMs) / MIN);
  const total = 19 * 60 + offMin;
  const h = Math.floor(total / 60) % 24;
  const m = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

main();
