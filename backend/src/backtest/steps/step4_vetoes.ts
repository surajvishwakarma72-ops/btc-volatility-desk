/**
 * STEP 4 — Veto economics (skip or delay).
 *
 * Each candidate veto blocks nights where its condition fires. A veto is kept only if
 * SL-precision (SLs blocked / nights blocked) > breakeven = avgWin/(avgWin+avgLoss),
 * net $ saved > 0, AND it holds in both OOS halves. Greedy-combine up to 4 (each must
 * catch NEW SLs). Also tests DELAY (re-enter at 01:00) vs SKIP for fired nights.
 *
 * Run: npx tsx src/backtest/steps/step4_vetoes.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN, type Frame } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { computeFeatures, type Features } from '../lib/indicators.js';
import { mean } from '../lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output');
const FIRST_DAY = '2025-10-06';
const LAST_DAY = '2026-10-17';
const ENTRY_OFF = 240; // 23:00 IST
const DELAY_OFF = 360; // 01:00 IST

interface Trade { idx: number; day: string; dow: number; f: Features; frame: Frame; stopped: boolean; pnl: number; }

const VETOES: { name: string; fire: (t: Trade) => boolean }[] = [
  { name: 'rsi15 > 60', fire: (t) => t.f.rsi15 > 60 },
  { name: 'rsi15 < 40', fire: (t) => t.f.rsi15 < 40 },
  { name: 'vwapSigma > 1', fire: (t) => t.f.vwapSigma > 1 },
  { name: '|vwapSigma| > 1.5', fire: (t) => Math.abs(t.f.vwapSigma) > 1.5 },
  { name: 'speed >= 1.5', fire: (t) => t.f.speed >= 1.5 },
  { name: 'NOT vovSmooth', fire: (t) => !t.f.vovSmooth },
  { name: 'iv < 35', fire: (t) => t.f.iv < 35 },
  { name: 'edge < -10', fire: (t) => t.f.edge < -10 },
  { name: 'range24 > 2', fire: (t) => t.f.range24 > 2 },
  { name: 'adx15 >= 30', fire: (t) => t.f.adx15 >= 30 },
  { name: 'weekday = Mon', fire: (t) => t.dow === 1 },
  { name: 'weekday = Tue', fire: (t) => t.dow === 2 },
];

function econ(trades: Trade[], fired: boolean[], avgWin: number, avgLoss: number) {
  let blocked = 0, slBlocked = 0, goodBlocked = 0;
  for (let i = 0; i < trades.length; i++) {
    if (!fired[i]) continue;
    blocked++;
    if (trades[i].stopped) slBlocked++; else goodBlocked++;
  }
  const precision = blocked ? slBlocked / blocked : 0;
  const saved = slBlocked * avgLoss;
  const lost = goodBlocked * avgWin;
  return { blocked, slBlocked, goodBlocked, precision, saved, lost, net: saved - lost };
}

function main() {
  const data = loadData();
  const trades: Trade[] = [];
  let idx = 0;
  for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow === 0 || f.dow === 6) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const sim = simulateStrangle(data, f, f.open + ENTRY_OFF * MIN, DEFAULT_SIM);
    if (!sim.ok) continue;
    trades.push({ idx: idx++, day, dow: f.dow, f: computeFeatures(data, f, f.open + ENTRY_OFF * MIN), frame: f, stopped: sim.stopped, pnl: sim.pnlUsd });
  }

  const n = trades.length;
  const half = Math.floor(n / 2);
  const avgWin = mean(trades.filter((t) => t.pnl > 0).map((t) => t.pnl));
  const avgLoss = Math.abs(mean(trades.filter((t) => t.stopped).map((t) => t.pnl)));
  const breakeven = avgWin / (avgWin + avgLoss);
  const baseSL = trades.filter((t) => t.stopped).length;
  const baseNet = trades.reduce((a, t) => a + t.pnl, 0);
  console.log('='.repeat(80));
  console.log(`VETO ECONOMICS — ${n} trades @ 23:00 IST | avgWin $${avgWin.toFixed(2)} avgLoss $${avgLoss.toFixed(2)}`);
  console.log(`  breakeven SL-precision = ${(breakeven * 100).toFixed(1)}%  | baseline: ${baseSL} SLs, net $${baseNet.toFixed(0)}`);

  // Per-veto economics + OOS.
  console.log('\nSINGLE VETOES (blocked = SL+good; keep if precision>breakeven, net>0, holds OOS):');
  console.log('  veto               blocked  SLs  good  prec%  saved$  lost$   net$   OOS-holds');
  const scored = VETOES.map((v) => {
    const fired = trades.map((t) => v.fire(t));
    const e = econ(trades, fired, avgWin, avgLoss);
    const e1 = econ(trades.slice(0, half), fired.slice(0, half), avgWin, avgLoss);
    const e2 = econ(trades.slice(half), fired.slice(half), avgWin, avgLoss);
    const oosHolds = e1.precision > breakeven && e2.precision > breakeven;
    return { v, fired, e, oosHolds };
  }).sort((a, b) => b.e.net - a.e.net);

  for (const s of scored) {
    console.log(
      `  ${s.v.name.padEnd(18)} ${String(s.e.blocked).padStart(6)} ${String(s.e.slBlocked).padStart(4)} ${String(s.e.goodBlocked).padStart(5)}  ${(s.e.precision * 100).toFixed(1).padStart(5)}  ${s.e.saved.toFixed(0).padStart(6)}  ${s.e.lost.toFixed(0).padStart(5)}  ${s.e.net.toFixed(0).padStart(5)}   ${s.e.precision > breakeven && s.e.net > 0 ? (s.oosHolds ? 'YES' : 'in-sample only') : 'no'}`,
    );
  }

  // Greedy combine (keep only net>0 & precision>breakeven & OOS, catching NEW SLs).
  const keepers = scored.filter((s) => s.e.precision > breakeven && s.e.net > 0 && s.oosHolds);
  const combo: typeof scored = [];
  const blockedMask = new Array(n).fill(false);
  for (const cand of keepers) {
    if (combo.length >= 4) break;
    // new SLs caught by this veto not already blocked
    let newSL = 0, newBlocked = 0;
    for (let i = 0; i < n; i++) {
      if (cand.fired[i] && !blockedMask[i]) { newBlocked++; if (trades[i].stopped) newSL++; }
    }
    if (newBlocked > 0 && newSL / newBlocked > breakeven) {
      combo.push(cand);
      for (let i = 0; i < n; i++) if (cand.fired[i]) blockedMask[i] = true;
    }
  }
  let slRemain = 0, kept = 0, keptNet = 0;
  for (let i = 0; i < n; i++) {
    if (blockedMask[i]) continue;
    kept++; keptNet += trades[i].pnl;
    if (trades[i].stopped) slRemain++;
  }
  console.log(`\nGREEDY COMBO (max 4): ${combo.map((c) => c.v.name).join(' + ') || '(none cleared breakeven)'}`);
  console.log(`  blocked ${blockedMask.filter(Boolean).length} nights -> kept ${kept} trades, SLs ${baseSL} -> ${slRemain}, net $${baseNet.toFixed(0)} -> $${keptNet.toFixed(0)}`);

  // DELAY vs SKIP: for the single best veto, re-enter at 01:00 on fired nights.
  const best = scored[0];
  let delaySL = 0, delayN = 0, delayNet = 0;
  for (let i = 0; i < n; i++) {
    if (!best.fired[i]) continue;
    const t = trades[i];
    const sim = simulateStrangle(data, t.frame, t.frame.open + DELAY_OFF * MIN, DEFAULT_SIM);
    if (!sim.ok) continue;
    delayN++; delayNet += sim.pnlUsd; if (sim.stopped) delaySL++;
  }
  console.log(`\nDELAY test on "${best.v.name}" fired nights (re-enter 01:00 instead of skip):`);
  console.log(`  ${delayN} nights: at 23:00 they were ${best.e.slBlocked}/${best.e.blocked} SL; delayed to 01:00 -> ${delaySL}/${delayN} SL, net $${delayNet.toFixed(0)}`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'step4_vetoes.json'), JSON.stringify({
    n, avgWin, avgLoss, breakeven, baseSL, baseNet,
    vetoes: scored.map((s) => ({ name: s.v.name, ...s.e, oosHolds: s.oosHolds })),
    combo: combo.map((c) => c.v.name), slRemain, keptNet,
  }, null, 2));
  console.log(`\n[step4] wrote ${path.join(OUT_DIR, 'step4_vetoes.json')}`);
}

main();
