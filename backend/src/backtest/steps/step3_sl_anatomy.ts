/**
 * STEP 3 — SL anatomy + indicator scorecard.
 *
 * One trade per weekday night at a representative late entry (23:00 IST), split into
 * SL vs non-SL. For every indicator: SL-day vs non-SL-day distribution + Cohen's d +
 * point-biserial, and precision/recall for predicting a non-SL (silent) night at the
 * indicator's backend threshold. Correlation-prune (|ρ|>0.7) and assign a verdict:
 * CORE / USEFUL / REDUNDANT / USELESS / HARMFUL. Also: which leg stops, and what
 * predicts the side.
 *
 * Run: npx tsx src/backtest/steps/step3_sl_anatomy.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { computeFeatures, type Features } from '../lib/indicators.js';
import { median, cohenD, pointBiserial, precisionRecall, pearson } from '../lib/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../output');
const FIRST_DAY = '2025-10-06';
const LAST_DAY = '2026-10-17';
const ENTRY_OFF = 240; // 23:00 IST

type Dir = 'low' | 'high' | 'mid' | 'band' | 'bool';
interface Spec { name: string; dir: Dir; thr: (v: number, med: number) => boolean; }
const SPECS: Spec[] = [
  { name: 'speed', dir: 'low', thr: (v) => v < 1.5 },
  { name: 'adx15', dir: 'low', thr: (v) => v < 20 },
  { name: 'rsi15', dir: 'mid', thr: (v) => v >= 35 && v <= 65 },
  { name: 'edge', dir: 'high', thr: (v) => v >= 0 },
  { name: 'range24', dir: 'low', thr: (v) => v < 2 },
  { name: 'iv', dir: 'high', thr: (v) => v >= 35 },
  { name: 'ivMinusClock', dir: 'low', thr: (v) => v < 0 },
  { name: 'ivTurnPct', dir: 'high', thr: (v) => v > 0 },
  { name: 'rv6h', dir: 'low', thr: (v, m) => v < m },
  { name: 'rv24h', dir: 'low', thr: (v, m) => v < m },
  { name: 'vovCont', dir: 'low', thr: (v, m) => v < m },
  { name: 'dvolSlope', dir: 'low', thr: (v) => v < 0 },
  { name: 'velPct', dir: 'low', thr: (v, m) => v < m },
  { name: 'vwapSigma', dir: 'band', thr: (v) => Math.abs(v) < 1 },
  { name: 'termSpread', dir: 'low', thr: (v, m) => v < m },
];
const BOOL_SPECS: { name: keyof Features }[] = [{ name: 'belowClock' }, { name: 'vovSmooth' }];

interface Trade { day: string; dow: number; f: Features; stopped: boolean; hurt: string; silence: boolean; }

function main() {
  const data = loadData();
  const trades: Trade[] = [];

  for (let dayMs = d0(FIRST_DAY); dayMs <= d0(LAST_DAY); dayMs += DAY) {
    const day = dk(dayMs + 12 * HR);
    const f = frame(d0(day) + 20 * HR);
    if (f.dow === 0 || f.dow === 6) continue;
    if (!data.hasIv(f.n2n) || f.exit > data.priceLast) continue;
    const entryT = f.open + ENTRY_OFF * MIN;
    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM);
    if (!sim.ok) continue;
    const feat = computeFeatures(data, f, entryT);
    trades.push({ day, dow: f.dow, f: feat, stopped: sim.stopped, hurt: sim.hurtLeg, silence: sim.silence });
  }

  const n = trades.length;
  const slRate = (trades.filter((t) => t.stopped).length / n) * 100;
  const nonSL = trades.map((t) => !t.stopped);
  const baseNonSL = nonSL.filter(Boolean).length / n;
  console.log('='.repeat(78));
  console.log(`SL ANATOMY — ${n} trades @ 23:00 IST, SL rate ${slRate.toFixed(1)}%, base non-SL ${(baseNonSL * 100).toFixed(1)}%`);

  // Build per-feature arrays (drop NaN per feature).
  const featVals = (name: string) => trades.map((t) => (t.f as any)[name] as number);
  const medians: Record<string, number> = {};
  for (const s of SPECS) medians[s.name] = median(featVals(s.name).filter(Number.isFinite));

  // Scorecard rows.
  const rows: any[] = [];
  for (const s of SPECS) {
    const pairs = trades.map((t) => ({ v: (t.f as any)[s.name] as number, non: !t.stopped })).filter((p) => Number.isFinite(p.v));
    const slVals = pairs.filter((p) => !p.non).map((p) => p.v);
    const nonVals = pairs.filter((p) => p.non).map((p) => p.v);
    const d = cohenD(nonVals, slVals);
    const pb = pointBiserial(pairs.map((p) => p.non), pairs.map((p) => p.v));
    const predicted = pairs.map((p) => s.thr(p.v, medians[s.name]));
    const actual = pairs.map((p) => p.non);
    const pr = precisionRecall(predicted, actual);
    rows.push({
      name: s.name, dir: s.dir,
      slMedian: +median(slVals).toFixed(2), nonMedian: +median(nonVals).toFixed(2),
      cohenD: +d.toFixed(2), pb: +pb.toFixed(2),
      precision: +(pr.precision * 100).toFixed(1), recall: +(pr.recall * 100).toFixed(1), lift: +pr.lift.toFixed(3),
      support: pr.support,
    });
  }
  for (const b of BOOL_SPECS) {
    const predicted = trades.map((t) => Boolean((t.f as any)[b.name]));
    const actual = trades.map((t) => !t.stopped);
    const pr = precisionRecall(predicted, actual);
    rows.push({ name: String(b.name), dir: 'bool', slMedian: NaN, nonMedian: NaN, cohenD: NaN, pb: NaN, precision: +(pr.precision * 100).toFixed(1), recall: +(pr.recall * 100).toFixed(1), lift: +pr.lift.toFixed(3), support: pr.support });
  }

  // Correlation prune among numeric features (|ρ|>0.7 -> keep higher |cohenD|).
  const strength = (name: string) => {
    const r = rows.find((x) => x.name === name);
    return Math.max(Math.abs(r?.cohenD || 0), Math.abs((r?.lift || 1) - 1) * 3);
  };
  const redundant = new Set<string>();
  for (let i = 0; i < SPECS.length; i++) {
    for (let j = i + 1; j < SPECS.length; j++) {
      const a = SPECS[i].name, b = SPECS[j].name;
      const pa = trades.map((t) => (t.f as any)[a] as number);
      const pb2 = trades.map((t) => (t.f as any)[b] as number);
      const idx = pa.map((_, k) => k).filter((k) => Number.isFinite(pa[k]) && Number.isFinite(pb2[k]));
      const rho = pearson(idx.map((k) => pa[k]), idx.map((k) => pb2[k]));
      if (Math.abs(rho) > 0.7) {
        const weaker = strength(a) >= strength(b) ? b : a;
        redundant.add(weaker);
      }
    }
  }

  // Verdicts.
  for (const r of rows) {
    const strong = Math.abs(r.cohenD || 0) >= 0.4 || r.lift >= 1.15;
    const mod = Math.abs(r.cohenD || 0) >= 0.2 || r.lift >= 1.07;
    const harmful = r.lift > 0 && r.lift <= 0.9;
    r.verdict = harmful ? 'HARMFUL' : redundant.has(r.name) ? 'REDUNDANT' : strong ? 'CORE' : mod ? 'USEFUL' : 'USELESS';
  }

  rows.sort((a, b) => (b.lift - a.lift) || (Math.abs(b.cohenD || 0) - Math.abs(a.cohenD || 0)));

  console.log('\nINDICATOR SCORECARD (predicting a non-SL night; sorted by lift):');
  console.log('  indicator      SLmed   nonSLmed  cohenD   pbr   prec%  recall%  lift   verdict');
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(13)} ${String(r.slMedian).padStart(6)} ${String(r.nonMedian).padStart(9)} ${String(r.cohenD).padStart(6)} ${String(r.pb).padStart(6)} ${String(r.precision).padStart(6)} ${String(r.recall).padStart(7)}  ${r.lift.toFixed(2).padStart(5)}  ${r.verdict}`,
    );
  }

  // Which leg stops + side predictor.
  const sl = trades.filter((t) => t.stopped);
  const callSL = sl.filter((t) => t.hurt === 'CALL');
  const putSL = sl.filter((t) => t.hurt === 'PUT');
  console.log(`\nWHICH LEG STOPS (${sl.length} SL trades): CALL ${callSL.length}  PUT ${putSL.length}`);
  console.log(`  median vwapSigma at entry — call-SL: ${median(callSL.map((t) => t.f.vwapSigma).filter(Number.isFinite)).toFixed(2)}  put-SL: ${median(putSL.map((t) => t.f.vwapSigma).filter(Number.isFinite)).toFixed(2)}  (>0 price above VWAP favors call blowout)`);
  console.log(`  median rsi15 — call-SL: ${median(callSL.map((t) => t.f.rsi15).filter(Number.isFinite)).toFixed(1)}  put-SL: ${median(putSL.map((t) => t.f.rsi15).filter(Number.isFinite)).toFixed(1)}`);

  const cores = rows.filter((r) => r.verdict === 'CORE' || r.verdict === 'USEFUL').map((r) => r.name);
  console.log(`\nKept (CORE/USEFUL): ${cores.join(', ')}`);
  console.log(`Redundant: ${[...redundant].join(', ') || '—'}`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'step3_scorecard.json');
  fs.writeFileSync(outPath, JSON.stringify({ n, slRate, baseNonSL, scorecard: rows, redundant: [...redundant], legSplit: { call: callSL.length, put: putSL.length } }, null, 2));
  console.log(`\n[step3] wrote ${outPath}`);
}

main();
