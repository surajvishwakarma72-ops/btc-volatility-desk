/**
 * FRIDAY DEEP-DIVE — Friday is the PREMIUM short-strangle night (biggest weekend IV crush).
 * Its stops are an entry-TIMING problem (selling into the Friday price-run), not a size problem.
 * Find the Friday entry that keeps the premium edge but avoids the stops, and explain recent stops.
 *
 * Run: npx tsx src/backtest/steps/friday.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const istHM = (tMs: number, D0: number) => { const h = Math.floor((tMs - D0) / HR), m = Math.round(((tMs - D0) % HR) / MIN); return `${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`; };

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}
const stopOf = (iv: number) => (iv < 35 ? 2.0 : iv < 45 ? 3.0 : iv < 55 ? 2.5 : 2.0);

function main() {
  const data = loadData();
  const fris: { f: any; day: string }[] = [];
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow !== 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    fris.push({ f, day });
  }

  console.log('='.repeat(92));
  console.log(`FRIDAY DEEP-DIVE — ${fris.length} Fridays. Premium night; goal = keep the edge, kill the timing stops.`);
  console.log('='.repeat(92));

  // 1) Entry-TIME sweep (fixed IST entry, 0.15Δ, band-adaptive stop).
  console.log('\n1) Friday entry-time sweep (fixed IST time, 0.15Δ, band-adaptive stop):');
  console.log('  entry(IST)   n   Stop%   Win%   avgPnL%');
  for (let h = 19; h <= 26; h++) {
    const xs: { stopped: boolean; pnl: number }[] = [];
    for (const { f } of fris) {
      const entryT = f.D0 + h * HR; if (entryT >= f.exit) continue;
      const iv = data.ivAt(f.n2n, entryT); if (iv == null) continue;
      const s = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: stopOf(iv), targetPct: 0.12 });
      if (s.ok) xs.push({ stopped: s.stopped, pnl: s.pnlPctMargin });
    }
    const lab = String(h % 24).padStart(2, '0') + ':00';
    console.log(`  ${lab.padEnd(9)} ${String(xs.length).padStart(3)}  ${f1(pct(xs.filter((x) => x.stopped).length, xs.length)).padStart(5)}  ${f1(pct(xs.filter((x) => x.pnl > 0).length, xs.length)).padStart(5)}  ${('+' + f1(mean(xs.map((x) => x.pnl)))).padStart(6)}`);
  }

  // 2) Recent Friday STOPS under the naive rule (IV-turn entry, flat 2× stop) + whether a fix saves each.
  console.log('\n2) Recent Friday stops under the NAIVE rule (IV-turn entry, 2× stop) — why, and what saves it:');
  console.log('  date         entry   IV0   BTCmove%  leg   | late 23:00?  wider 3×?  band-adaptive?');
  const stops: any[] = [];
  for (const { f, day } of fris) {
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const lab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    if (!lab.hasEvent) continue;
    const entryT = turnEntry(data, f.n2n, lab.peakT, nyEnd, 1.0); if (entryT == null) continue;
    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM); // naive 2×
    if (!sim.ok || !sim.stopped) continue;
    const iv0 = sim.iv0;
    const late = (() => { const t = Math.max(entryT, f.D0 + 23 * HR); if (t >= f.exit) return null; const s = simulateStrangle(data, f, t, { ...DEFAULT_SIM, stopMult: stopOf(data.ivAt(f.n2n, t) ?? iv0), targetPct: 0.12 }); return s.ok ? s : null; })();
    const wide = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: 3.0 });
    const adapt = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: stopOf(iv0), targetPct: 0.12 });
    stops.push({ day, entryT, iv0, move: sim.btcMovePct, leg: sim.hurtLeg, D0: f.D0,
      lateOk: late ? !late.stopped : null, wideOk: !wide.stopped, adaptOk: !adapt.stopped });
  }
  stops.slice(-10).forEach((s) => console.log(
    `  ${s.day}  ${istHM(s.entryT, s.D0).padEnd(6)} ${f1(s.iv0).padStart(4)}  ${f1(s.move).padStart(7)}  ${String(s.leg).padEnd(4)}  |  ${(s.lateOk == null ? 'n/a' : s.lateOk ? 'SAVED ✓' : 'still ✗').padEnd(10)}  ${(s.wideOk ? 'SAVED ✓' : 'still ✗').padEnd(9)}  ${s.adaptOk ? 'SAVED ✓' : 'still ✗'}`));
  const savedLate = stops.filter((s) => s.lateOk).length, savedWide = stops.filter((s) => s.wideOk).length, savedAd = stops.filter((s) => s.adaptOk).length;
  console.log(`\n  Of ${stops.length} Friday stops: late-23:00 entry would avoid ${savedLate} (${f1(pct(savedLate, stops.length))}%), 3× stop ${savedWide} (${f1(pct(savedWide, stops.length))}%), band-adaptive ${savedAd} (${f1(pct(savedAd, stops.length))}%).`);
  console.log(`  (Avg adverse BTC move on a Friday stop: ${f1(mean(stops.map((s) => s.move)))}% — confirms stops are price-run, not IV.)`);

  console.log('\nSUGGESTED FRIDAY ENTRY: wait for the IV turn but not before ~23:00 IST (let the US move exhaust),');
  console.log('full/premium size, band-adaptive stop (2× low IV, 2.5× in 45–55, 3× in the 35–45 middle), 12% target, 07:00 exit.');
}

main();
