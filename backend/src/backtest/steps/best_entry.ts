/**
 * BEST ENTRY — the conditions-based gate that AVOIDS the stop-loss (not blind daily entry).
 * Honest comparison: every candidate gate vs trading every IV-turn night. For each we report how
 * many nights it TRADES vs WAITS (coverage), the stop rate, win rate, and avg P&L. The goal is the
 * LOWEST stop rate that still keeps positive expectancy — and to show the cost (fewer trades) openly.
 *
 * Strict 2× stop throughout (your rule). No cherry-picking: all gates printed side by side.
 * Run: npx tsx src/backtest/steps/best_entry.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';
import { computeFeatures, type Features } from '../lib/indicators.js';

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
  // Collect every NY IV-turn night with its entry, IV and features + strict-2× outcome.
  const ent: { iv0: number; feat: Features; pnl: number; stopped: boolean; win: boolean }[] = [];
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
    const s = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: 2.0, targetPct: 0.12 });
    if (!s.ok) continue;
    ent.push({ iv0, feat: computeFeatures(data, f, entryT), pnl: s.pnlPctMargin, stopped: s.stopped, win: s.pnlPctMargin > 0 });
  }
  const medEdge = [...ent.map((e) => e.feat.edge)].filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(ent.length / 2)];
  const N = ent.length;

  const score = (gate: (e: typeof ent[number]) => boolean) => {
    const g = ent.filter(gate);
    return { n: g.length, cov: pct(g.length, N), stop: pct(g.filter((x) => x.stopped).length, g.length),
      win: pct(g.filter((x) => x.win).length, g.length), avg: mean(g.map((x) => x.pnl)) };
  };

  // Candidate conditions (each is a reason a night could stay GO).
  const inBand = (e: typeof ent[number], lo: number, hi: number) => e.iv0 >= lo && e.iv0 < hi;
  const calm = (e: typeof ent[number]) => e.feat.speed < 1.5;
  const rich = (e: typeof ent[number]) => e.feat.edge >= medEdge;

  const gates: [string, (e: typeof ent[number]) => boolean][] = [
    ['BASELINE — every IV-turn night', () => true],
    ['IV 25–35 (calm band)', (e) => inBand(e, 25, 35)],
    ['IV 25–45 (low half)', (e) => inBand(e, 25, 45)],
    ['IV 45–60 (rich band)', (e) => inBand(e, 45, 60)],
    ['Edge-rich only', (e) => rich(e)],
    ['Calm (speed<1.5) only', (e) => calm(e)],
    ['Edge-rich + calm', (e) => rich(e) && calm(e)],
    ['Calm band 25–35 + edge-rich', (e) => inBand(e, 25, 35) && rich(e)],
    ['Skip dead-zone 35–45 + edge-rich', (e) => !inBand(e, 35, 45) && rich(e)],
    ['Skip 35–45 + edge-rich + calm', (e) => !inBand(e, 35, 45) && rich(e) && calm(e)],
    ['A+ (calm band OR rich-high) + calm', (e) => (inBand(e, 25, 35) || (inBand(e, 45, 60) && rich(e))) && calm(e)],
  ];

  console.log('='.repeat(96));
  console.log(`BEST ENTRY — stop-avoiding gates vs trading every night (strict 2×, ${N} IV-turn nights over the year)`);
  console.log('='.repeat(96));
  console.log('  gate                                     trades  cover%   Stop%   Win%   avgPnL%   /yr');
  for (const [lab, gate] of gates) {
    const s = score(gate);
    const perYr = s.avg * s.n; // total % of margin captured across the year
    console.log(`  ${lab.padEnd(40)} ${String(s.n).padStart(5)}   ${f1(s.cov).padStart(5)}   ${f1(s.stop).padStart(5)}  ${f1(s.win).padStart(5)}  ${('+' + f1(s.avg)).padStart(6)}  ${('+' + f1(perYr)).padStart(6)}`);
  }

  console.log('\n  Read it straight: lower Stop% is the goal; cover% is how many nights you actually trade');
  console.log('  (100% = every night, lower = more WAIT nights). /yr is total margin% captured — fewer');
  console.log('  but cleaner trades can still beat trading everything once stops are removed.');
}

main();
