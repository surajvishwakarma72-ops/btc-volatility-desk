/**
 * Export per-day backtest results under the FINAL ruleset, for the live Master Strategy
 * Blueprint page (clock, 7-day streak, calendar). Replaces the legacy BT_269 (old rules).
 *
 * Final ruleset: weekends + Wed/Thu = SKIP (OOS win <65%); Mon/Tue/Fri = TRADE at the
 * late 23:00 IST entry; skip when RSI(14) > 60 (overbought veto); symmetric 0.15Δ, 2x
 * stop, 07:00 exit. Records each weekday night's outcome.
 *
 * Output: frontend/public/data/backtest_days.js ->
 *   window.__STRANGLE_BT_DAYS = { "YYYY-MM-DD": {v,s,w,pnl,note} }
 *     v: verdict 'TRADE'|'SKIP'  s: stopped(bool)  w: win(bool)  pnl: % of margin  note
 *
 * Run: npx tsx src/backtest/steps/export_days.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { computeFeatures } from '../lib/indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FE = path.resolve(__dirname, '../../../../frontend/public/data');
const ENTRY_OFF = 240; // 23:00 IST
const SKIP_DOW = new Set([0, 3, 4, 6]); // Sun, Wed, Thu, Sat

function main() {
  const data = loadData();
  const days: Record<string, any> = {};

  for (let dayMs = d0('2025-10-06'); dayMs <= d0('2026-10-17'); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (SKIP_DOW.has(f.dow)) {
      days[day] = { v: 'SKIP', s: false, w: false, pnl: 0, note: f.dow === 0 || f.dow === 6 ? 'Weekend off' : f.dow === 4 ? 'Thursday expiry shock (OOS)' : 'Wednesday decayed out-of-sample' };
      continue;
    }
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const entryT = f.open + ENTRY_OFF * MIN;
    const feat = computeFeatures(data, f, entryT);
    if (feat.rsi15 > 60) {
      days[day] = { v: 'SKIP', s: false, w: false, pnl: 0, note: `RSI ${Math.round(feat.rsi15)} > 60 (overbought veto)` };
      continue;
    }
    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM);
    if (!sim.ok) continue;
    days[day] = {
      v: 'TRADE',
      s: sim.stopped,
      w: sim.pnlUsd > 0,
      pnl: +sim.pnlPctMargin.toFixed(1),
      note: sim.outcome,
    };
  }

  fs.mkdirSync(FE, { recursive: true });
  const n = Object.keys(days).length;
  const traded = Object.values(days).filter((d: any) => d.v === 'TRADE').length;
  const wins = Object.values(days).filter((d: any) => d.v === 'TRADE' && d.w).length;
  const stops = Object.values(days).filter((d: any) => d.s).length;
  fs.writeFileSync(path.join(FE, 'backtest_days.js'), `window.__STRANGLE_BT_DAYS = ${JSON.stringify(days)};\n`);
  console.log(`[export_days] ${n} days (${traded} traded, ${wins} wins, ${stops} stops) -> frontend/public/data/backtest_days.js`);
}

main();
