/**
 * LEVELS — do day/week high-low levels help avoid the stop? Three tests on the real 1-yr strangle:
 *   1) Price POSITION in the prior-week range at entry (near low / mid / near high) → stop rate.
 *   2) Is the CALL strike beyond the prior-week HIGH (a resistance barrier)? → call-stop rate protected vs not.
 *   3) Is the PUT strike beyond the prior-week LOW (a support barrier)? → put-stop rate protected vs not.
 * Band-adaptive stop, IV-turn entry.
 * Run: npx tsx src/backtest/steps/levels.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
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
const hiLo = (bars: any[]) => { let hi = -Infinity, lo = Infinity; for (const b of bars) { if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; } return { hi, lo }; };

function main() {
  const data = loadData();
  const ns: { posW: number; stopped: boolean; hurt: string; callProt: boolean; putProt: boolean }[] = [];
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const f = frame(d0(dk(dayMs + 12 * HR)) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    if (!sLab.hasEvent) continue;
    const entryT = turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0); if (entryT == null) continue;
    const iv0 = data.ivAt(f.n2n, entryT); if (iv0 == null) continue;
    const week = hiLo(data.bars1mBetween(entryT - 7 * DAY, entryT));
    if (!(week.hi > 0) || !(week.lo > 0) || week.hi <= week.lo) continue;
    const s = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, stopMult: stopOf(iv0), targetPct: 0.12 });
    if (!s.ok) continue;
    const posW = (s.spot0 - week.lo) / (week.hi - week.lo);          // 0 = at week low, 1 = at week high
    const callProt = s.Kc > week.hi;                                 // call strike is beyond the week high (resistance barrier)
    const putProt = s.Kp < week.lo;                                  // put strike is beyond the week low (support barrier)
    ns.push({ posW, stopped: s.stopped, hurt: (s.hurtLeg || '').toLowerCase(), callProt, putProt });
  }

  console.log('='.repeat(84));
  console.log(`LEVELS — ${ns.length} IV-turn nights (real 1-yr, band-adaptive stop)`);
  console.log('='.repeat(84));

  console.log('\n1) PRICE POSITION in the prior-week range at entry:');
  console.log('  position              n    stop%');
  const posB: [string, (p: number) => boolean][] = [['near low (0–33%)', (p) => p < 0.33], ['mid (33–66%)', (p) => p >= 0.33 && p < 0.66], ['near high (66–100%)', (p) => p >= 0.66]];
  for (const [lab, t] of posB) { const g = ns.filter((x) => t(x.posW)); if (g.length) console.log(`  ${lab.padEnd(20)} ${String(g.length).padStart(3)}   ${f1(pct(g.filter((x) => x.stopped).length, g.length)).padStart(5)}`); }

  console.log('\n2) CALL leg — strike BEYOND the prior-week high (resistance barrier)?');
  const cp = ns.filter((x) => x.callProt), cu = ns.filter((x) => !x.callProt);
  console.log(`  protected (Kc > week-high):   ${String(cp.length).padStart(3)} · call-stops ${f1(pct(cp.filter((x) => x.hurt === 'call').length, cp.length))}%`);
  console.log(`  unprotected (Kc inside range):${String(cu.length).padStart(3)} · call-stops ${f1(pct(cu.filter((x) => x.hurt === 'call').length, cu.length))}%`);

  console.log('\n3) PUT leg — strike BEYOND the prior-week low (support barrier)?');
  const pp = ns.filter((x) => x.putProt), pu = ns.filter((x) => !x.putProt);
  console.log(`  protected (Kp < week-low):    ${String(pp.length).padStart(3)} · put-stops ${f1(pct(pp.filter((x) => x.hurt === 'put').length, pp.length))}%`);
  console.log(`  unprotected (Kp inside range):${String(pu.length).padStart(3)} · put-stops ${f1(pct(pu.filter((x) => x.hurt === 'put').length, pu.length))}%`);
  console.log('\n  Read: lower stop% near mid-range and when the strike sits BEYOND a week level = levels help place strikes / defend legs.');
}

main();
