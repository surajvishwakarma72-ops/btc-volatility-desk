/**
 * TERM-SPREAD BACKTEST (REAL multi-expiry IV — but 1 YEAR only, the horizon I actually have).
 *   spread = front (cur) ATM IV − N2N (3rd) ATM IV at entry.
 *     spread > 0 = BACKWARDATION (near-term IV elevated = stress/fear).
 *     spread < 0 = CONTANGO (near < far = calm/normal).
 * Does selling into backwardation (front stress) stop more than selling in contango? Strict-2× strangle,
 * IV-turn entry. NOTE: a real 5-year version is impossible — only the 30-day DVOL exists for 5yr, not the
 * front-vs-N2N term structure. This uses the 1yr real option-IV archive.
 * Run: npx tsx src/backtest/steps/term_spread.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}
const stopOf = (iv: number) => (iv >= 35 && iv < 45 ? 3.0 : 2.0);

function main() {
  const data = loadData();
  const rows: { spread: number; stopped: boolean; win: boolean }[] = [];
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const f = frame(d0(dk(dayMs + 12 * HR)) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    if (!sLab.hasEvent) continue;
    const entryT = turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0);
    if (entryT == null) continue;
    const curIv = data.ivAt(f.cur, entryT), n2nIv = data.ivAt(f.n2n, entryT);
    if (curIv == null || n2nIv == null) continue;
    const s = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: stopOf(n2nIv), targetPct: 0.12 });
    if (!s.ok) continue;
    rows.push({ spread: curIv - n2nIv, stopped: s.stopped, win: s.pnlPctMargin > 0 });
  }

  const buckets: [string, (x: number) => boolean][] = [
    ['strong contango < −3', (x) => x < -3],
    ['mild contango −3..−1', (x) => x >= -3 && x < -1],
    ['flat −1..+1', (x) => x >= -1 && x <= 1],
    ['mild backwardation +1..+3', (x) => x > 1 && x <= 3],
    ['strong backwardation > +3', (x) => x > 3],
  ];
  console.log('='.repeat(86));
  console.log(`TERM SPREAD (front cur − N2N IV) — ${rows.length} IV-turn nights, 1yr REAL option IV (${FIRST}→${LAST})`);
  console.log('='.repeat(86));
  console.log('  term-structure bucket            n    stop%   win%');
  for (const [lab, test] of buckets) {
    const g = rows.filter((r) => test(r.spread)); if (!g.length) { console.log(`  ${lab.padEnd(30)}   0    —      —`); continue; }
    console.log(`  ${lab.padEnd(30)} ${String(g.length).padStart(3)}   ${f1(pct(g.filter((r) => r.stopped).length, g.length)).padStart(5)}  ${f1(pct(g.filter((r) => r.win).length, g.length)).padStart(5)}`);
  }
  const back = rows.filter((r) => r.spread > 1), cont = rows.filter((r) => r.spread < -1);
  console.log(`\n  Backwardation (front > N2N, stress): ${back.length} nights · stop ${f1(pct(back.filter((r) => r.stopped).length, back.length))}%`);
  console.log(`  Contango (front < N2N, calm):        ${cont.length} nights · stop ${f1(pct(cont.filter((r) => r.stopped).length, cont.length))}%`);
  console.log(`  avg spread ${f1(mean(rows.map((r) => r.spread)))} pts (BTC short-dated usually trades ${mean(rows.map((r) => r.spread)) > 0 ? 'backwardated' : 'in contango'}).`);
  console.log('\n  HONEST: 1 year only. A real 5-year term spread needs multi-tenor IV history I do not have (DVOL = 30d single tenor).');
}

main();
