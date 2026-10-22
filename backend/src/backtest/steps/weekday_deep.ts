/**
 * WEEKDAY DEEP — the per-day master plan + improvement program (what the user asked for).
 * For each weekday it answers, from the backtest:
 *   • which DELTA to sell (IV-wise: 0.10Δ further-OTM in the 40–45 band, else 0.15Δ)
 *   • which LEG to manage (the one that usually breaks)
 *   • the IV-wise stop (band-adaptive 2×/3×) and the IV-fall the day needs to win
 *   • HISTORY — what every previous same-weekday did (IV, IV-fall, outcome)
 *   • IMPROVE — what the stops had in common → how to treat the next one
 * Emits frontend/public/data/weekday_deep.js → window.__STRANGLE_WEEKDAY_DEEP
 * Run: npx tsx src/backtest/steps/weekday_deep.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush } from '../lib/signals.js';
import { computeFeatures } from '../lib/indicators.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const r1 = (x: number) => +(+x).toFixed(1);
const deltaOf = (iv: number) => (iv >= 40 && iv < 45 ? 0.10 : 0.15);
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
  type Rec = { date: string; iv: number; ivFall: number; speed: number; out: string; pnl: number; leg: string };
  const byD: Record<number, Rec[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (let dayMs = d0(FIRST); dayMs <= d0(LAST); dayMs += DAY) {
    const dayKey = dk(dayMs + 12 * HR);
    const f = frame(d0(dayKey) + 20 * HR);
    if (f.dow < 1 || f.dow > 5) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const nyStart = f.D0 + NY[0] * HR, nyEnd = f.D0 + NY[1] * HR;
    const sLab = classifyCrush(data.ivWindow(f.n2n, nyStart, nyEnd), nyStart, nyEnd, nyEnd);
    if (!sLab.hasEvent) continue;
    const entryT = turnEntry(data, f.n2n, sLab.peakT, nyEnd, 1.0); if (entryT == null) continue;
    const iv0 = data.ivAt(f.n2n, entryT); if (iv0 == null) continue;
    const feat = computeFeatures(data, f, entryT);
    const ivw = data.ivWindow(f.n2n, entryT, f.exit).map((x: [number, number]) => x[1]);
    const ivMin = ivw.length ? Math.min(...ivw) : iv0;
    const s = simulateStrangle(data, f, entryT, { ...DEFAULT_SIM, deltaCall: deltaOf(iv0), deltaPut: deltaOf(iv0), stopMult: stopOf(iv0), targetPct: 0.12 });
    if (!s.ok) continue;
    const out = s.stopped ? `SL-${(s.hurtLeg || '').toUpperCase()}` : (s.outcome === 'TARGET' ? 'TARGET' : s.pnlPctMargin > 0 ? 'TIME-WIN' : 'TIME-FLAT');
    byD[f.dow].push({ date: dayKey, iv: r1(iv0), ivFall: r1(iv0 - ivMin), speed: r1(feat.speed), out, pnl: r1(s.pnlPctMargin), leg: s.stopped ? (s.hurtLeg || '').toLowerCase() : '' });
  }

  const outObj: Record<string, any> = {};
  for (const d of [1, 2, 3, 4, 5]) {
    const r = byD[d]; if (!r.length) continue;
    const stops = r.filter((x) => x.out.startsWith('SL'));
    const put = stops.filter((x) => x.leg === 'put').length, call = stops.filter((x) => x.leg === 'call').length;
    const leg = call >= put ? 'call' : 'put';
    const avgIV = r1(mean(r.map((x) => x.iv)));
    const stopIVfall = mean(stops.map((x) => x.ivFall));   // how much IV fell on the nights that STILL stopped
    const winIVfall = mean(r.filter((x) => x.pnl > 0).map((x) => x.ivFall));
    outObj[DOW[d]] = {
      n: r.length,
      stopPct: r1(pct(stops.length, r.length)),
      winPct: r1(pct(r.filter((x) => x.pnl > 0).length, r.length)),
      avgIV,
      leg,                                   // the leg to manage
      deltaRule: '0.15Δ — but 0.10Δ (further OTM) if IV is 40–45',
      stopRule: '2× — but 3× if IV is 35–45 (gives the mid-band room)',
      ivFallToWin: r1(winIVfall),            // avg IV-fall on winning nights (the target)
      ivNote: avgIV >= 45 ? 'rich zone — cleanest crush' : avgIV >= 35 ? 'mid-band — trade at 3× stop' : 'calm/thin — 2× fits, thin premium is fine',
      improve: `Stops here were mostly ${leg}-side (${call >= put ? call : put}/${stops.length}) and happened when IV fell only ~${r1(stopIVfall)}pt vs ~${r1(winIVfall)}pt on wins. FIX: only sell once IV is clearly turning down, and defend the ${leg} leg (go 0.10Δ on that side if stretched).`,
      history: r.slice(-10).map((x) => ({ date: x.date, iv: x.iv, fall: x.ivFall, out: x.out, pnl: x.pnl })),
    };
  }

  const feDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../frontend/public/data');
  fs.mkdirSync(feDir, { recursive: true });
  fs.writeFileSync(path.join(feDir, 'weekday_deep.js'), `window.__STRANGLE_WEEKDAY_DEEP = ${JSON.stringify(outObj)};\n`);

  console.log('WEEKDAY DEEP — per-day master plan + improvement:');
  for (const d of [1, 2, 3, 4, 5]) { const o = outObj[DOW[d]]; if (!o) continue; console.log(`  ${DOW[d]}: ${o.n} nights · ${o.winPct}% win · ${o.stopPct}% stop · avgIV ${o.avgIV} · manage ${o.leg} · wins fell ~${o.ivFallToWin}pt`); }
  console.log('\n[weekday_deep] wrote frontend/public/data/weekday_deep.js (window.__STRANGLE_WEEKDAY_DEEP).');
}

main();
