/**
 * POLISH — extra ways to cut stops / lift gains on the NY short strangle, beyond IV+stop tuning.
 * Tests, vs the tuned base (0.15Δ / 2.5× stop, NY IV-turn entry, 07:00 exit):
 *   • Asymmetric strikes — widen the threatened leg by RSI (overbought→wider call; oversold→wider put)
 *   • VWAP-location veto — only sell when BTC sits near session VWAP (|σ|<1), not stretched
 *   • Calm veto — only sell when Speed (RV1h/IV) < 1.5
 *   • Edge veto — only sell when IV is rich vs realized (edge ≥ median)
 *   • Stacked combos
 * Run: npx tsx src/backtest/steps/polish.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM, type SimConfig } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';
import { computeFeatures, type Features } from '../lib/indicators.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

const BASE: SimConfig = { ...DEFAULT_SIM, stopMult: 2.5 }; // tuned base

function main() {
  const data = loadData();
  const ent: { f: any; entryT: number; feat: Features }[] = [];
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
    ent.push({ f, entryT, feat: computeFeatures(data, f, entryT) });
  }
  const mEdge = median(ent.map((e) => e.feat.edge));

  // A scenario = optional entry filter + a per-trade config builder.
  const run = (filter: (F: Features) => boolean, cfgOf: (F: Features) => SimConfig) => {
    const xs: { pnl: number; stopped: boolean }[] = [];
    for (const e of ent) {
      if (!filter(e.feat)) continue;
      const s = simulateStrangle(data, e.f, e.entryT, cfgOf(e.feat));
      if (s.ok) xs.push({ pnl: s.pnlPctMargin, stopped: s.stopped });
    }
    return { n: xs.length, stop: pct(xs.filter((x) => x.stopped).length, xs.length), win: pct(xs.filter((x) => x.pnl > 0).length, xs.length), pnl: mean(xs.map((x) => x.pnl)) };
  };
  const SYM = () => BASE;
  // Asymmetric: widen (lower-delta / further-OTM) the leg RSI says is threatened.
  const ASYM = (F: Features): SimConfig => F.rsi15 > 55 ? { ...BASE, deltaCall: 0.10, deltaPut: 0.15 }
    : F.rsi15 < 45 ? { ...BASE, deltaCall: 0.15, deltaPut: 0.10 } : BASE;
  const all = () => true;
  const nearVwap = (F: Features) => Math.abs(F.vwapSigma) < 1;
  const calm = (F: Features) => F.speed < 1.5;
  const rich = (F: Features) => F.edge >= mEdge;

  const base = run(all, SYM);
  const rows: [string, ReturnType<typeof run>][] = [
    ['BASE (0.15Δ/2.5×, all)', base],
    ['+ Asymmetric by RSI', run(all, ASYM)],
    ['+ VWAP veto |σ|<1', run(nearVwap, SYM)],
    ['+ Calm veto spd<1.5', run(calm, SYM)],
    ['+ Edge-rich veto', run(rich, SYM)],
    ['Asym + VWAP veto', run(nearVwap, ASYM)],
    ['Asym + Calm + Edge', run((F) => calm(F) && rich(F), ASYM)],
    ['Asym + VWAP + Calm + Edge', run((F) => nearVwap(F) && calm(F) && rich(F), ASYM)],
  ];

  console.log('='.repeat(88));
  console.log('POLISH — cut stops / lift gains vs tuned base (NY IV-turn, 0.15Δ, 2.5× stop):');
  console.log('='.repeat(88));
  console.log('  scenario                       n    Stop%   Win%   avgPnL%   ΔStop   ΔPnL');
  for (const [lab, r] of rows) {
    console.log(`  ${lab.padEnd(28)} ${String(r.n).padStart(3)}  ${f1(r.stop).padStart(5)}  ${f1(r.win).padStart(5)}  ${('+' + f1(r.pnl)).padStart(6)}   ${((r.stop - base.stop >= 0 ? '+' : '') + f1(r.stop - base.stop)).padStart(5)}  ${((r.pnl - base.pnl >= 0 ? '+' : '') + f1(r.pnl - base.pnl)).padStart(5)}`);
  }
}

main();
