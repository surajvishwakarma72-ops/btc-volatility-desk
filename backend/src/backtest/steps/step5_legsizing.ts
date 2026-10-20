/**
 * STEP 5 — Leg sizing / asymmetry.
 *
 * For SL elimination, the lever that changes SL FREQUENCY is how far OTM each leg sits
 * (a per-leg 2x stop is easier to hit on a near leg). We test symmetric 0.15/0.15 vs a
 * directional delta-skew driven by VWAP position (the only directional signal with mild
 * power in Step 3): price above VWAP -> push the call further OTM (call 0.10, put 0.15),
 * below -> push the put further OTM. Reported over the Step-4-surviving set (rsi15<=60).
 *
 * (25Δ skew / gamma-flip / options-flow drivers are data-limited — sparse archive — and
 * noted rather than used; see plan.)
 *
 * Run: npx tsx src/backtest/steps/step5_legsizing.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { computeFeatures } from '../lib/indicators.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output');
const FIRST_DAY = '2025-10-06';
const LAST_DAY = '2026-10-17';
const ENTRY_OFF = 240;

function run(label: string, deltaFor: (vwapSigma: number) => { c: number; p: number }) {
  const data = loadData();
  let n = 0, sl = 0, net = 0;
  for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow === 0 || f.dow === 6) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const entryT = f.open + ENTRY_OFF * MIN;
    const feat = computeFeatures(data, f, entryT);
    if (feat.rsi15 > 60) continue; // apply the Step-4 veto
    const d = deltaFor(feat.vwapSigma);
    const sim = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, deltaCall: d.c, deltaPut: d.p });
    if (!sim.ok) continue;
    n++; if (sim.stopped) sl++; net += sim.pnlUsd;
  }
  return { label, n, sl, slRate: +((sl / n) * 100).toFixed(1), net: +net.toFixed(0) };
}

function main() {
  const variants = [
    run('symmetric 0.15/0.15', () => ({ c: 0.15, p: 0.15 })),
    run('symmetric 0.12/0.12', () => ({ c: 0.12, p: 0.12 })),
    run('symmetric 0.10/0.10', () => ({ c: 0.10, p: 0.10 })),
    run('VWAP-skew (0.10 risk leg)', (s) => (s > 0.5 ? { c: 0.10, p: 0.15 } : s < -0.5 ? { c: 0.15, p: 0.10 } : { c: 0.15, p: 0.15 })),
    run('VWAP-skew (0.08 risk leg)', (s) => (s > 0.5 ? { c: 0.08, p: 0.15 } : s < -0.5 ? { c: 0.15, p: 0.08 } : { c: 0.15, p: 0.15 })),
  ];
  console.log('='.repeat(70));
  console.log('LEG SIZING (over rsi15<=60 survivors @ 23:00 IST):');
  console.log('  variant                       n    SL%    net$');
  for (const v of variants) console.log(`  ${v.label.padEnd(28)} ${String(v.n).padStart(3)}  ${String(v.slRate).padStart(5)}  ${String(v.net).padStart(6)}`);
  console.log('\nNote: further-OTM reduces SL frequency but also collects less credit — net is the tiebreaker.');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'step5_legsizing.json'), JSON.stringify({ variants }, null, 2));
  console.log(`[step5] wrote ${path.join(OUT_DIR, 'step5_legsizing.json')}`);
}

main();
