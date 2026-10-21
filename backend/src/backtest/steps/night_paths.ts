/**
 * NIGHT PATHS — per-trade BTC price road, so entry + exit are visible ON the chart.
 * For every TRADE night we export the 15m BTC closes from 18:00 (NY open) to 07:00 (exit),
 * plus the ENTRY point (where you sold), the EXIT point (where you closed), and the two strike
 * "guard-rails" (Kc above, Kp below) — stay between them = win, a leg breach = the 2× stop.
 *
 * Emits frontend/public/data/strangle_paths.js → window.__STRANGLE_PATHS
 *   { 'YYYY-MM-DD': { s, step, px:[close…], entry:{m,p}, exit:{m,p}, kc, kp, out, stopped, hurt } }
 *   s = start minute-offset from local midnight (D0); step = 15; m = minute-offset from D0.
 *
 * Run: npx tsx src/backtest/steps/night_paths.ts
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
const START_H = 18, STEP_MIN = 15; // chart window: 18:00 → exit, 15-minute closes

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}
const priceAt = (data: any, t: number): number | null => {
  const s = data.entrySpot(t); if (s != null) return s;
  const b = data.bars1mBetween(t - 8 * MIN, t + 8 * MIN); // nearest 1m close for off-grid times
  return b.length ? b[Math.floor(b.length / 2)].c : null;
};

function main() {
  const data = loadData();
  const paths: Record<string, any> = {};
  let n = 0, bars = 0;

  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const dayKey = dk(dayMs + 12 * HR);
    const f = frame(d0(dayKey) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;

    const isFri = f.dow === 5;
    const winOpen = f.D0 + (isFri ? 23 : 22) * HR;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    let entryT = sLab.hasEvent ? turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0) : null;
    if (entryT == null || entryT < winOpen) entryT = Math.min(Math.max(entryT ?? winOpen, winOpen), f.exit - HR);
    if (data.ivAt(f.n2n, entryT) == null) continue;

    const sim = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: 2.0, targetPct: 0.12 });
    if (!sim.ok) continue;

    // 15m close path from 18:00 to exit.
    const startMs = f.D0 + START_H * HR;
    const px: number[] = [];
    let last = priceAt(data, startMs) ?? sim.spot0;
    for (let t = startMs; t <= f.exit; t += STEP_MIN * MIN) {
      const p = priceAt(data, t); if (p != null) last = p;
      px.push(Math.round(last));
    }
    const minFromD0 = (ms: number) => Math.round((ms - f.D0) / MIN);
    paths[dayKey] = {
      s: Math.round((startMs - f.D0) / MIN), step: STEP_MIN, px,
      entry: { m: minFromD0(entryT), p: Math.round(sim.spot0) },
      exit: { m: minFromD0(sim.exitMs), p: Math.round(priceAt(data, sim.exitMs) ?? sim.spot0) },
      kc: Math.round(sim.Kc), kp: Math.round(sim.Kp),
      out: sim.stopped ? `SL-${sim.hurtLeg}` : (sim.outcome === 'TARGET' ? 'TARGET' : sim.pnlUsd > 0 ? 'TIME-WIN' : 'TIME-FLAT'),
      stopped: sim.stopped, hurt: sim.stopped ? sim.hurtLeg : 'NONE',
    };
    n++; bars += px.length;
  }

  const feDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data');
  fs.mkdirSync(feDir, { recursive: true });
  fs.writeFileSync(path.join(feDir, 'strangle_paths.js'), `window.__STRANGLE_PATHS = ${JSON.stringify(paths)};\n`);

  console.log('='.repeat(92));
  console.log('NIGHT PATHS — BTC road per trade (18:00→07:00, 15m), entry/exit/strikes marked:');
  console.log('='.repeat(92));
  console.log(`  ${n} nights · ${bars} price points · ~${Math.round(bars / n)} bars/night`);
  const sample = Object.entries(paths).slice(0, 5);
  for (const [date, p] of sample) {
    const x = p as any;
    const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    console.log(`  ${date}  enter ${hm(x.entry.m)}@${x.entry.p} → exit ${hm(x.exit.m)}@${x.exit.p}  road ${x.kp}–${x.kc}  ${x.out}`);
  }
  console.log(`\n[night_paths] wrote frontend/public/data/strangle_paths.js (window.__STRANGLE_PATHS) — ${n} nights.`);
}

main();
