/**
 * GATE REFINE — is "edge-rich / thick premium" a valid filter, or is IV FALLING (the crush) the real signal?
 * The trader's claim: thin premium is fine if IV crushes hard (e.g. Friday). Test it on real 1-yr IV:
 *   • does the edge filter actually help, vs dropping it?
 *   • do thin-edge nights still WIN when IV falls a lot?
 *   • is IV-fall a better predictor of a win than edge?
 * Band-adaptive stop (3× in 35–45, else 2×), IV-turn entry.
 * Run: npx tsx src/backtest/steps/gate_refine.ts
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
const stopOf = (iv: number) => (iv >= 35 && iv < 45 ? 3.0 : 2.0);

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

function main() {
  const data = loadData();
  const ns: { iv0: number; ivFall: number; edge: number; speed: number; stopped: boolean; win: boolean; pnl: number }[] = [];
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
    const feat: Features = computeFeatures(data, f, entryT);
    // IV fall over the hold = entry IV − minimum IV before exit
    const ivw = data.ivWindow(f.n2n, entryT, f.exit).map((x: [number, number]) => x[1]);
    const ivMin = ivw.length ? Math.min(...ivw) : iv0;
    const s = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: stopOf(iv0), targetPct: 0.12 });
    if (!s.ok) continue;
    ns.push({ iv0, ivFall: iv0 - ivMin, edge: feat.edge, speed: feat.speed, stopped: s.stopped, win: s.pnlPctMargin > 0, pnl: s.pnlPctMargin });
  }
  const medEdge = [...ns.map((n) => n.edge)].filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(ns.length / 2)];
  const stat = (g: typeof ns) => ({ n: g.length, cov: pct(g.length, ns.length), stop: pct(g.filter((x) => x.stopped).length, g.length), win: pct(g.filter((x) => x.win).length, g.length), avg: mean(g.map((x) => x.pnl)) });
  const row = (lab: string, g: typeof ns) => { const s = stat(g); console.log(`  ${lab.padEnd(36)} ${String(s.n).padStart(3)}  ${f1(s.cov).padStart(5)}  ${f1(s.stop).padStart(5)}  ${f1(s.win).padStart(5)}  ${('+' + f1(s.avg)).padStart(6)}`); };

  console.log('='.repeat(90));
  console.log(`GATE REFINE — ${ns.length} IV-turn nights (real 1-yr IV, band-adaptive stop)`);
  console.log('='.repeat(90));
  console.log('  gate                                   n   cover%  Stop%   Win%   avgPnL%');
  row('A. every IV-turn (no edge filter)', ns);
  row('B. + edge-rich (current gate)', ns.filter((x) => x.edge >= medEdge));
  row('C. + calm speed < 1.0 (no edge)', ns.filter((x) => x.speed < 1.0));
  row('D. + calm speed < 1.0 + edge-rich', ns.filter((x) => x.speed < 1.0 && x.edge >= medEdge));

  console.log('\nTHE THIN-EDGE QUESTION (do thin-premium nights still win?):');
  const thin = ns.filter((x) => x.edge < medEdge);
  const thinBigFall = thin.filter((x) => x.ivFall >= 3);
  console.log(`  thin-edge nights:            ${thin.length} · win ${f1(pct(thin.filter((x) => x.win).length, thin.length))}% · stop ${f1(pct(thin.filter((x) => x.stopped).length, thin.length))}% · avg +${f1(mean(thin.map((x) => x.pnl)))}`);
  console.log(`  thin-edge + IV fell ≥3pt:    ${thinBigFall.length} · win ${f1(pct(thinBigFall.filter((x) => x.win).length, thinBigFall.length))}% · avg +${f1(mean(thinBigFall.map((x) => x.pnl)))}  ← the Fridays you mean`);

  console.log('\nIV-FALL vs EDGE as the win signal (win% by bucket):');
  const byFall = [[0, 1, '<1pt (barely fell)'], [1, 3, '1–3pt'], [3, 6, '3–6pt'], [6, 99, '6pt+ (big crush)']] as [number, number, string][];
  for (const [lo, hi, lab] of byFall) { const g = ns.filter((x) => x.ivFall >= lo && x.ivFall < hi); if (g.length) console.log(`  IV fell ${lab.padEnd(20)} ${String(g.length).padStart(3)} · win ${f1(pct(g.filter((x) => x.win).length, g.length))}% · avg +${f1(mean(g.map((x) => x.pnl)))}`); }
  console.log('\n  Read: if thin-edge still wins (esp. with a big IV fall), the edge filter is over-conservative — IV FALLING is the signal.');
}

main();
