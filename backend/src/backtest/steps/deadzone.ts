/**
 * DEAD-ZONE REVIVAL — is the 35–45 IV band really dead, or does it just need different handling?
 * Instead of skipping it, backtest what would make it TRADEABLE: more stop room, further-OTM strikes,
 * later entry, or combinations. Honest side-by-side on the 35–45 nights only.
 * Run: npx tsx src/backtest/steps/deadzone.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM, type SimConfig } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
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
  // Collect 35–45 band IV-turn nights.
  const dz: { f: any; entryT: number; iv0: number }[] = [];
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const f = frame(d0(dk(dayMs + 12 * HR)) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    if (!sLab.hasEvent) continue;
    const entryT = turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0);
    if (entryT == null) continue;
    const iv0 = data.ivAt(f.n2n, entryT); if (iv0 == null) continue;
    if (iv0 >= 35 && iv0 < 45) dz.push({ f, entryT, iv0 });
  }

  const run = (cfg: Partial<SimConfig>, lateMin = 0) => {
    const xs: { pnl: number; stopped: boolean }[] = [];
    for (const e of dz) {
      const entryT = e.entryT + lateMin * MIN;
      if (entryT >= e.f.exit) continue;
      const s = simulateStrangle(data, e.f, entryT, { ...DEFAULT_SIM, ...cfg });
      if (s.ok) xs.push({ pnl: s.pnlPctMargin, stopped: s.stopped });
    }
    return { n: xs.length, stop: pct(xs.filter((x) => x.stopped).length, xs.length),
      win: pct(xs.filter((x) => x.pnl > 0).length, xs.length), avg: mean(xs.map((x) => x.pnl)), tot: xs.reduce((s, x) => s + x.pnl, 0) };
  };

  const rows: [string, ReturnType<typeof run>][] = [
    ['BASE  0.15Δ · 2.0× · on turn', run({ stopMult: 2.0, targetPct: 0.12 })],
    ['+ wider stop 2.5×', run({ stopMult: 2.5, targetPct: 0.12 })],
    ['+ wider stop 3.0×', run({ stopMult: 3.0, targetPct: 0.12 })],
    ['+ further OTM 0.10Δ · 2.0×', run({ deltaCall: 0.10, deltaPut: 0.10, stopMult: 2.0, targetPct: 0.12 })],
    ['+ further OTM 0.10Δ · 2.5×', run({ deltaCall: 0.10, deltaPut: 0.10, stopMult: 2.5, targetPct: 0.12 })],
    ['+ later entry (turn+60m) · 2.0×', run({ stopMult: 2.0, targetPct: 0.12 }, 60)],
    ['+ later entry + 0.10Δ · 2.0×', run({ deltaCall: 0.10, deltaPut: 0.10, stopMult: 2.0, targetPct: 0.12 }, 60)],
    ['+ later + 0.10Δ + 2.5×', run({ deltaCall: 0.10, deltaPut: 0.10, stopMult: 2.5, targetPct: 0.12 }, 60)],
    ['+ smaller target 8% · 0.12Δ · 2.0×', run({ deltaCall: 0.12, deltaPut: 0.12, stopMult: 2.0, targetPct: 0.08 })],
  ];

  console.log('='.repeat(92));
  console.log(`DEAD-ZONE (IV 35–45) REVIVAL — ${dz.length} nights. What makes it tradeable instead of skipped?`);
  console.log('='.repeat(92));
  console.log('  variant                               n    Stop%   Win%   avgPnL%   total%');
  for (const [lab, r] of rows) {
    console.log(`  ${lab.padEnd(36)} ${String(r.n).padStart(3)}  ${f1(r.stop).padStart(5)}  ${f1(r.win).padStart(5)}  ${('+' + f1(r.avg)).padStart(6)}  ${('+' + f1(r.tot)).padStart(6)}`);
  }
  console.log('\n  Goal: find a handling where 35–45 stops drop toward the other bands (≤26%) at positive avg.');
  console.log('  If nothing does, the band is genuinely low-edge and WAIT is honest. The data decides.');
}

main();
