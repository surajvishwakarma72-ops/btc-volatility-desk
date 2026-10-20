/**
 * STEP 7 — Best-day predictors & conviction tiers.
 *
 * Over the final ruleset (late 23:00 entry, rsi15<=60 veto, symmetric 0.15, 2x stop),
 * measure per-weekday win%, expectancy, and median minutes-to-target (how fast the 10%
 * target is hit). Assign conviction HIGH / NORMAL / SKIP from expectancy + win rate.
 *
 * Run: npx tsx src/backtest/steps/step7_bestday.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { computeFeatures } from '../lib/indicators.js';
import { mean, median } from '../lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output');
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ENTRY_OFF = 240;

function main() {
  const data = loadData();
  const byDow: Record<number, { pnl: number[]; win: number; n: number; ttt: number[] }> = {};
  for (let d = 1; d <= 5; d++) byDow[d] = { pnl: [], win: 0, n: 0, ttt: [] };

  for (let dayMs = d0('2025-10-06'); dayMs <= d0('2026-10-17'); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const entryT = f.open + ENTRY_OFF * MIN;
    const feat = computeFeatures(data, f, entryT);
    if (feat.rsi15 > 60) continue;
    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM);
    if (!sim.ok) continue;
    const b = byDow[f.dow];
    b.n++; b.pnl.push(sim.pnlUsd); if (sim.pnlUsd > 0) b.win++;
    if (sim.outcome === 'TARGET') b.ttt.push((sim.exitMs - entryT) / HR);
  }

  const rows = [1, 2, 3, 4, 5].map((d) => {
    const b = byDow[d];
    return {
      dow: DOW[d], n: b.n,
      winRate: +((b.win / b.n) * 100).toFixed(1),
      expectancy: +mean(b.pnl).toFixed(2),
      medHrsToTarget: b.ttt.length ? +median(b.ttt).toFixed(1) : null,
    };
  });
  // Conviction from expectancy + win rate.
  for (const r of rows as any[]) {
    r.conviction = r.expectancy > 1.5 && r.winRate >= 65 ? 'HIGH' : r.expectancy > 0 ? 'NORMAL' : 'SKIP';
  }

  console.log('='.repeat(64));
  console.log('BEST-DAY / CONVICTION (final ruleset: late + rsi veto):');
  console.log('  day   n   win%   expectancy$  medHrs->target  conviction');
  for (const r of rows as any[]) {
    console.log(`  ${r.dow}  ${String(r.n).padStart(3)}  ${String(r.winRate).padStart(5)}  ${String(r.expectancy).padStart(10)}  ${String(r.medHrsToTarget ?? '—').padStart(12)}   ${r.conviction}`);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'step7_bestday.json'), JSON.stringify({ rows }, null, 2));
  console.log(`[step7] wrote ${path.join(OUT_DIR, 'step7_bestday.json')}`);
}

main();
