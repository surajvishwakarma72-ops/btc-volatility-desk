/**
 * FINAL COMBINED STRATEGY — the IV + indicator rules that survived the whole study, backtested end-to-end.
 *   Entry  : NY session, weekday, sell when ATM IV turns down (N2N, IV-turn).
 *   Filter : edge-rich (IV ≥ realized+median) — the one polish that cut stops without losing gain.
 *   Strikes: 0.15Δ (0.10Δ in the 40–45 band).
 *   Stop   : IV-band-adaptive — 2.0× (IV<35 or ≥55), 3.0× (35–45 muddy middle), 2.5× (45–55 money zone).
 *   Exit   : 12% target (let winners run) or hard 07:00 IST.
 * Compared to BASE (trade every IV-turn, flat 0.15Δ / 2.0× stop / 10% target).
 * Run: npx tsx src/backtest/steps/final_strategy.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM, type SimConfig } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';
import { computeFeatures, type Features } from '../lib/indicators.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}
const stopOf = (iv: number) => (iv >= 35 && iv < 55 ? 2.5 : 2.0); // capped at 2.5× — no 3× (too wide)
const deltaOf = (iv: number) => (iv >= 40 && iv < 45 ? 0.10 : 0.15);

function main() {
  const data = loadData();
  const ent: { f: any; entryT: number; iv0: number; feat: Features }[] = [];
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
    const iv0 = data.ivAt(f.n2n, entryT); if (iv0 == null) continue;
    ent.push({ f, entryT, iv0, feat: computeFeatures(data, f, entryT) });
  }
  const medEdge = [...ent.map((e) => e.feat.edge)].filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(ent.length / 2)];

  const run = (filter: (e: typeof ent[number]) => boolean, cfgOf: (e: typeof ent[number]) => SimConfig) => {
    const xs: { pnl: number; stopped: boolean; iv0: number }[] = [];
    for (const e of ent) {
      if (!filter(e)) continue;
      const s = simulateStrangle(data, e.f, e.entryT, cfgOf(e));
      if (s.ok) xs.push({ pnl: s.pnlPctMargin, stopped: s.stopped, iv0: e.iv0 });
    }
    return xs;
  };
  const stat = (xs: { pnl: number; stopped: boolean }[]) => ({
    n: xs.length, stop: pct(xs.filter((x) => x.stopped).length, xs.length),
    win: pct(xs.filter((x) => x.pnl > 0).length, xs.length), avg: mean(xs.map((x) => x.pnl)), tot: sum(xs.map((x) => x.pnl)),
  });

  const base = run(() => true, () => DEFAULT_SIM);
  const adaptive = run(() => true, (e) => ({ ...DEFAULT_SIM, deltaCall: deltaOf(e.iv0), deltaPut: deltaOf(e.iv0), stopMult: stopOf(e.iv0), targetPct: 0.12 }));
  const finalF = run((e) => e.feat.edge >= medEdge, (e) => ({ ...DEFAULT_SIM, deltaCall: deltaOf(e.iv0), deltaPut: deltaOf(e.iv0), stopMult: stopOf(e.iv0), targetPct: 0.12 }));

  console.log('='.repeat(92));
  console.log('FINAL STRATEGY RESULT — NY short strangle, IV + indicator rules (span 2025-10 → 2026-10)');
  console.log('='.repeat(92));
  console.log('  strategy                                   n    Stop%   Win%   avgPnL%   total%/yr');
  const row = (lab: string, s: ReturnType<typeof stat>) => console.log(`  ${lab.padEnd(40)} ${String(s.n).padStart(3)}  ${f1(s.stop).padStart(5)}  ${f1(s.win).padStart(5)}  ${('+' + f1(s.avg)).padStart(6)}   ${('+' + f1(s.tot)).padStart(7)}`);
  row('BASE (every IV-turn · 0.15Δ · 2× · 10%)', stat(base));
  row('+ adaptive stop/delta · 12% target', stat(adaptive));
  row('FINAL (+ edge-rich filter)', stat(finalF));

  console.log('\nFINAL strategy by IV band (adaptive stop + edge filter):');
  console.log('  IV band    n    stop(×)  Stop%   Win%   avgPnL%');
  const bands: [string, (iv: number) => boolean][] = [
    ['25-35', (iv) => iv >= 25 && iv < 35], ['35-45', (iv) => iv >= 35 && iv < 45],
    ['45-55', (iv) => iv >= 45 && iv < 55], ['55+', (iv) => iv >= 55],
  ];
  for (const [lab, test] of bands) {
    const xs = finalF.filter((x) => test(x.iv0)); if (!xs.length) continue;
    const sx = stat(xs);
    const st = lab === '45-55' || lab === '35-45' ? '2.5' : '2.0';
    console.log(`  ${lab.padEnd(8)} ${String(sx.n).padStart(3)}  ${st.padStart(5)}×   ${f1(sx.stop).padStart(5)}  ${f1(sx.win).padStart(5)}  ${('+' + f1(sx.avg)).padStart(6)}`);
  }

  const b = stat(base), ff = stat(finalF);
  console.log('\nBOTTOM LINE:');
  console.log(`  Base:  ${b.n} trades, ${f1(b.stop)}% stop, ${f1(b.win)}% win, +${f1(b.avg)}%/trade, +${f1(b.tot)}%/yr total.`);
  console.log(`  Final: ${ff.n} trades, ${f1(ff.stop)}% stop, ${f1(ff.win)}% win, +${f1(ff.avg)}%/trade, +${f1(ff.tot)}%/yr total.`);
  console.log(`  → stop ${f1(b.stop)}%→${f1(ff.stop)}%, win ${f1(b.win)}%→${f1(ff.win)}%, per-trade +${f1(b.avg)}%→+${f1(ff.avg)}% of margin.`);
}

main();
