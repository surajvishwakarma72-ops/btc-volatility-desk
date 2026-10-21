/**
 * BEST TRADE PER IV BAND — don't just trade the sweet spot; find the optimal (delta, stop) for EVERY
 * entry ATM-IV band. NY short strangle, N2N, IV-turn entry, 07:00 exit. Shows that low/high bands
 * may need different handling (thin-credit low IV → wider stop; etc.) rather than being skipped.
 *
 * Run: npx tsx src/backtest/steps/iv_band_best.ts
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

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

function main() {
  const data = loadData();
  const entries: { f: any; entryT: number; iv0: number }[] = [];
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    if (!sLab.hasEvent) continue;
    const entryT = turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0);
    if (entryT == null) continue;
    const iv0 = data.ivAt(f.n2n, entryT);
    if (iv0 == null) continue;
    entries.push({ f, entryT, iv0 });
  }

  const deltas = [0.1, 0.125, 0.15];
  const stops = [2.0, 2.5, 3.0];
  // Pre-simulate every entry under every (delta, stop) config.
  type Row = { iv0: number; pnl: number; stopped: boolean };
  const sims: Record<string, Row[]> = {};
  for (const dl of deltas) for (const sm of stops) {
    const key = `${dl}/${sm}`;
    sims[key] = [];
    for (const e of entries) {
      const s = simulateStrangle(data, e.f, e.entryT, { ...DEFAULT_SIM, deltaCall: dl, deltaPut: dl, stopMult: sm });
      if (s.ok) sims[key].push({ iv0: e.iv0, pnl: s.pnlPctMargin, stopped: s.stopped });
    }
  }

  const ivs = entries.map((e) => e.iv0);
  const floor = Math.floor(Math.min(...ivs) / 5) * 5, ceil = Math.ceil(Math.max(...ivs) / 5) * 5;
  const agg = (rows: Row[], a: number, b: number) => {
    const x = rows.filter((r) => r.iv0 >= a && r.iv0 < b);
    return { n: x.length, win: pct(x.filter((r) => r.pnl > 0).length, x.length), stop: pct(x.filter((r) => r.stopped).length, x.length), pnl: mean(x.map((r) => r.pnl)) };
  };

  console.log('='.repeat(100));
  console.log('BEST TRADE PER IV BAND — NY short strangle (IV-turn entry, 07:00 exit); best (delta, stop) per band:');
  console.log('='.repeat(100));
  console.log('  IV band    n    BASE(0.15/2.0)         BEST config          Δwin   ΔPnL');
  console.log('                   win%  stop% avgPnL%   cfg        win%  stop% avgPnL%');
  for (let b = floor; b < ceil; b += 5) {
    const base = agg(sims['0.15/2'], b, b + 5);
    if (base.n < 6) continue;
    let best: { key: string; s: ReturnType<typeof agg> } | null = null;
    for (const key of Object.keys(sims)) {
      const s = agg(sims[key], b, b + 5);
      if (!best || s.pnl > best.s.pnl) best = { key, s };
    }
    const d = best!.key.replace('/', 'Δ/') + '×';
    console.log(
      `  ${(b + '-' + (b + 5)).padEnd(8)} ${String(base.n).padStart(3)}  ${f1(base.win).padStart(5)} ${f1(base.stop).padStart(5)} ${('+' + f1(base.pnl)).padStart(6)}   ` +
      `${d.padEnd(11)} ${f1(best!.s.win).padStart(4)} ${f1(best!.s.stop).padStart(5)} ${('+' + f1(best!.s.pnl)).padStart(6)}  ${((best!.s.win - base.win >= 0 ? '+' : '') + f1(best!.s.win - base.win)).padStart(5)} ${((best!.s.pnl - base.pnl >= 0 ? '+' : '') + f1(best!.s.pnl - base.pnl)).padStart(5)}`);
  }

  // Per-band stop-width sensitivity (at 0.15Δ) to show how the optimal stop shifts with IV.
  console.log('\nSTOP-WIDTH by IV band (0.15Δ) — avgPnL% at each stop (⟵ best):');
  console.log('  IV band    n     2.0×    2.5×    3.0×');
  for (let b = floor; b < ceil; b += 5) {
    const n = agg(sims['0.15/2'], b, b + 5).n; if (n < 6) continue;
    const p2 = agg(sims['0.15/2'], b, b + 5).pnl, p25 = agg(sims['0.15/2.5'], b, b + 5).pnl, p3 = agg(sims['0.15/3'], b, b + 5).pnl;
    const best = Math.max(p2, p25, p3);
    const c = (v: number) => (('+' + f1(v)) + (Math.abs(v - best) < 1e-9 ? ' ⟵' : '   ')).padStart(8);
    console.log(`  ${(b + '-' + (b + 5)).padEnd(8)} ${String(n).padStart(3)}  ${c(p2)}${c(p25)}${c(p3)}`);
  }
}

main();
