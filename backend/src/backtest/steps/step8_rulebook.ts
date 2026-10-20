/**
 * STEP 8 — Calendar rulebook with walk-forward OOS.
 *
 * Applies the final ruleset (late 23:00 entry, rsi15<=60 veto, symmetric 0.15Δ, 2x stop,
 * 07:00 exit) across all weekdays, classifies each TRADE / TRADE-LIGHT / SKIP using
 * out-of-sample win% (first half builds, second half tests), flags fragile days (within
 * 5 pts of the ~65% breakeven win), and breaks down by week-of-month and month.
 * News blackout is data-limited (no event calendar in the dataset) and is flagged, not
 * fabricated — high-SL date clusters are surfaced instead.
 *
 * Run: npx tsx src/backtest/steps/step8_rulebook.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { computeFeatures } from '../lib/indicators.js';
import { mean } from '../lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ENTRY_OFF = 240;
const BREAKEVEN_WIN = 65; // avgLoss/(avgWin+avgLoss) ≈ 11.73/(6.29+11.73)

interface T { dow: number; month: string; wom: number; pnl: number; stopped: boolean; half: 0 | 1; }

function main() {
  const data = loadData();
  const trades: T[] = [];
  const all: { day: string; ms: number }[] = [];
  for (let dayMs = d0('2025-10-06'); dayMs <= d0('2026-10-17'); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    all.push({ day, ms: dayMs });
  }
  const splitMs = all[Math.floor(all.length / 2)].ms;

  for (const { day, ms } of all) {
    const f = frame(d0(day) + 20 * HR);
    const entryT = f.open + ENTRY_OFF * MIN;
    const feat = computeFeatures(data, f, entryT);
    if (feat.rsi15 > 60) continue; // veto
    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM);
    if (!sim.ok) continue;
    const dom = new Date(day).getUTCDate();
    trades.push({ dow: f.dow, month: day.slice(0, 7), wom: Math.min(4, Math.floor((dom - 1) / 7) + 1), pnl: sim.pnlUsd, stopped: sim.stopped, half: ms < splitMs ? 0 : 1 });
  }

  // Per-weekday classification with OOS.
  console.log('='.repeat(78));
  console.log('CALENDAR RULEBOOK (final ruleset) — per weekday, OOS-validated:');
  console.log('  day   n   win%   IS-win  OOS-win  expectancy$   verdict        fragile');
  const perDay: any[] = [];
  for (let d = 1; d <= 5; d++) {
    const dd = trades.filter((t) => t.dow === d);
    if (!dd.length) continue;
    const win = (arr: T[]) => (arr.filter((t) => t.pnl > 0).length / arr.length) * 100;
    const isW = win(dd.filter((t) => t.half === 0));
    const oosW = win(dd.filter((t) => t.half === 1));
    const w = win(dd);
    const exp = mean(dd.map((t) => t.pnl));
    const verdict = oosW >= 70 && exp > 0 ? 'TRADE' : oosW >= 65 && exp > 0 ? 'TRADE-LIGHT' : 'SKIP';
    const fragile = Math.abs(oosW - BREAKEVEN_WIN) <= 5;
    perDay.push({ dow: DOW[d], n: dd.length, winRate: +w.toFixed(1), isWin: +isW.toFixed(1), oosWin: +oosW.toFixed(1), expectancy: +exp.toFixed(2), verdict, fragile });
    console.log(`  ${DOW[d]}  ${String(dd.length).padStart(3)}  ${w.toFixed(1).padStart(5)}  ${isW.toFixed(1).padStart(6)}  ${oosW.toFixed(1).padStart(7)}  ${exp.toFixed(2).padStart(10)}   ${verdict.padEnd(12)}  ${fragile ? 'FRAGILE' : ''}`);
  }

  // Week-of-month.
  console.log('\nBY WEEK-OF-MONTH:');
  for (let w = 1; w <= 4; w++) {
    const ww = trades.filter((t) => t.wom === w);
    if (!ww.length) continue;
    console.log(`  W${w}: n=${ww.length}  win ${((ww.filter((t) => t.pnl > 0).length / ww.length) * 100).toFixed(1)}%  exp $${mean(ww.map((t) => t.pnl)).toFixed(2)}`);
  }

  // Worst months (SL clusters) as a news-blackout proxy.
  const months = [...new Set(trades.map((t) => t.month))].sort();
  const monthRows = months.map((m) => {
    const mm = trades.filter((t) => t.month === m);
    return { m, n: mm.length, slRate: +((mm.filter((t) => t.stopped).length / mm.length) * 100).toFixed(0), exp: +mean(mm.map((t) => t.pnl)).toFixed(2) };
  }).sort((a, b) => b.slRate - a.slRate);
  console.log('\nHIGHEST-SL MONTHS (news-blackout proxy — no event calendar in data):');
  for (const r of monthRows.slice(0, 4)) console.log(`  ${r.m}: SL ${r.slRate}%  exp $${r.exp}  (n=${r.n})`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'step8_rulebook.json'), JSON.stringify({ perDay, months: monthRows, splitDay: dk(splitMs + 12 * HR) }, null, 2));
  console.log(`\n[step8] wrote ${path.join(OUT_DIR, 'step8_rulebook.json')}`);
}

main();
