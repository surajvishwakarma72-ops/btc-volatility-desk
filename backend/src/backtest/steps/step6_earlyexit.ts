/**
 * STEP 6 — Early exit for residual SLs.
 *
 * The actionable "in-trade warning" is a TIGHTER per-leg stop: exit earlier (at 1.5x or
 * 1.75x of entry premium) instead of riding to 2.0x. This caps the loss on SL nights but
 * also cuts short winners that merely wobbled near the stop. We sweep the stop multiple
 * over the Step-4 survivors (rsi15<=60) and report SL%, avg loss, net, and winners-cut.
 *
 * Run: npx tsx src/backtest/steps/step6_earlyexit.ts
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
const FIRST_DAY = '2025-10-06';
const LAST_DAY = '2026-10-17';
const ENTRY_OFF = 240;

function sweep(stopMult: number) {
  const data = loadData();
  let n = 0, sl = 0, net = 0;
  const losses: number[] = [];
  for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow === 0 || f.dow === 6) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const entryT = f.open + ENTRY_OFF * MIN;
    const feat = computeFeatures(data, f, entryT);
    if (feat.rsi15 > 60) continue;
    const sim = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult });
    if (!sim.ok) continue;
    n++; if (sim.stopped) { sl++; losses.push(sim.pnlUsd); } net += sim.pnlUsd;
  }
  return { stopMult, n, sl, slRate: +((sl / n) * 100).toFixed(1), avgLoss: +mean(losses).toFixed(2), net: +net.toFixed(0) };
}

function main() {
  const data = loadData();
  // How many 2.0x WINNERS wobbled past 1.5x (would be cut by a 1.5x stop)?
  let winnersPast15 = 0, winners = 0;
  for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow === 0 || f.dow === 6) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const entryT = f.open + ENTRY_OFF * MIN;
    const feat = computeFeatures(data, f, entryT);
    if (feat.rsi15 > 60) continue;
    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM);
    if (!sim.ok || sim.stopped) continue;
    if (sim.pnlUsd > 0) { winners++; if (sim.maxMarkRatio >= 1.5) winnersPast15++; }
  }

  const rows = [sweep(2.0), sweep(1.75), sweep(1.5)];
  console.log('='.repeat(64));
  console.log('EARLY EXIT — tighter per-leg stop (rsi15<=60 survivors @ 23:00):');
  console.log('  stopMult   n    SL%   avgLoss$   net$');
  for (const r of rows) console.log(`  ${r.stopMult.toFixed(2)}x    ${String(r.n).padStart(3)}  ${String(r.slRate).padStart(4)}  ${String(r.avgLoss).padStart(7)}   ${String(r.net).padStart(5)}`);
  console.log(`\nWinners that wobbled >=1.5x (a 1.5x stop would have cut these): ${winnersPast15}/${winners}`);
  console.log('Tighter stop caps losses but converts near-miss winners into losses — net is the judge.');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'step6_earlyexit.json'), JSON.stringify({ rows, winnersPast15, winners }, null, 2));
  console.log(`[step6] wrote ${path.join(OUT_DIR, 'step6_earlyexit.json')}`);
}

main();
