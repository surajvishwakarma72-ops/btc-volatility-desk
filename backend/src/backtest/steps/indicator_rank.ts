/**
 * STANDALONE INDICATOR RANKING — NY short strangle (N2N, 0.15Δ, IV-turn entry, 07:00 exit, 2× stop).
 *
 * Ranks the historically-backtestable fx indicators, bifurcated into:
 *   ENTRY — feature value AT entry → does it predict a WIN? (median split, PnL separation)
 *   HOLD  — feature value AT entry → does it predict SURVIVING to exit (no stop)?
 *   EXIT  — dynamic in-trade trigger → does it fire BEFORE a stop (early warning) without
 *           cutting winners? (recall of stops vs false-alarm on winners)
 *
 * Only indicators computable from archived data (candles + ATM IV + DVOL) are ranked; flow/GEX/
 * skew/liq/footprint/funding-history are data-limited and listed as not-backtestable.
 *
 * Run: npx tsx src/backtest/steps/indicator_rank.ts
 */
import { loadData } from '../data/load.js';
import { frame, d0, dk, DAY, HR, MIN } from '../lib/frame.js';
import { simulateStrangle, DEFAULT_SIM } from '../lib/simulate.js';
import { classifyCrush, rvAnnualizedPct } from '../lib/signals.js';
import { computeFeatures, type Features } from '../lib/indicators.js';

const FIRST = '2025-10-06', LAST = '2026-10-17';
const NY: [number, number] = [18.5, 25.5];
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
const median = (a: number[]) => { const s = [...a].filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function turnEntry(data: any, n2n: string, peakT: number, endMs: number, turnPts = 1.0): number | null {
  const peakIv = data.ivAt(n2n, peakT); if (peakIv == null) return null;
  for (let t = Math.ceil(peakT / (15 * MIN)) * (15 * MIN); t <= endMs; t += 15 * MIN) {
    const iv = data.ivAt(n2n, t); if (iv != null && peakIv - iv >= turnPts) return t;
  }
  return null;
}

interface Trade { feat: Features; win: boolean; stopped: boolean; pnl: number; f: any; entryT: number; stopT: number | null; spot0: number; }

function main() {
  const data = loadData();
  const trades: Trade[] = [];
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
    const feat = computeFeatures(data, f, entryT);
    const sim = simulateStrangle(data, f, entryT, DEFAULT_SIM);
    if (!sim.ok) continue;
    trades.push({ feat, win: sim.pnlPctMargin > 0, stopped: sim.stopped, pnl: sim.pnlPctMargin, f, entryT, stopT: sim.stopped ? sim.exitMs : null, spot0: sim.spot0 });
  }

  const baseWin = pct(trades.filter((t) => t.win).length, trades.length);
  const baseSurv = pct(trades.filter((t) => !t.stopped).length, trades.length);
  console.log('='.repeat(94));
  console.log(`STANDALONE NY SHORT-STRANGLE — INDICATOR RANKING (n=${trades.length} trades; base win ${f1(baseWin)}%, base survive ${f1(baseSurv)}%)`);
  console.log('='.repeat(94));

  // Backtestable indicators: fx id, name, getter.
  const INDS: { fx: string; name: string; get: (F: Features) => number }[] = [
    { fx: 'spd', name: 'Speed vs IV (RV1h/IV)', get: (F) => F.speed },
    { fx: 'iv', name: 'ATM IV level', get: (F) => F.iv },
    { fx: 'ton', name: 'IV − clock (vs 17:30)', get: (F) => F.ivMinusClock },
    { fx: 'edge', name: 'Edge (IV − RV24)', get: (F) => F.edge },
    { fx: 'rng', name: 'Range 24H %', get: (F) => F.range24 },
    { fx: 'adx', name: 'ADX 14 (trend)', get: (F) => F.adx15 },
    { fx: 'rsi', name: 'RSI 14', get: (F) => F.rsi15 },
    { fx: 'term', name: 'Term spread (Cur − N2N)', get: (F) => F.termSpread },
    { fx: 'vov', name: 'Vol-of-vol (3h σ of IV)', get: (F) => F.vovCont },
    { fx: 'dv', name: 'DVOL slope (6h)', get: (F) => F.dvolSlope },
    { fx: 'vwap', name: 'VWAP σ distance |σ|', get: (F) => Math.abs(F.vwapSigma) },
    { fx: 'rv', name: 'RV 6h', get: (F) => F.rv6h },
    { fx: 'spd2', name: 'Price velocity 1h %', get: (F) => F.velPct },
    { fx: 'turn', name: 'IV turn-down % off peak', get: (F) => F.ivTurnPct },
  ];

  const splitRank = (metric: (t: Trade) => boolean, baseP: number, title: string) => {
    const rows = INDS.map((ind) => {
      const vals = trades.map((t) => ind.get(t.feat)).filter(Number.isFinite);
      const med = median(vals);
      const hi = trades.filter((t) => Number.isFinite(ind.get(t.feat)) && ind.get(t.feat) >= med);
      const lo = trades.filter((t) => Number.isFinite(ind.get(t.feat)) && ind.get(t.feat) < med);
      const pHi = pct(hi.filter(metric).length, hi.length), pLo = pct(lo.filter(metric).length, lo.length);
      const pnlHi = mean(hi.map((t) => t.pnl)), pnlLo = mean(lo.map((t) => t.pnl));
      const favHigh = pnlHi >= pnlLo;
      return { ind, med, favDir: favHigh ? 'HIGH' : 'LOW', favP: favHigh ? pHi : pLo, favPnl: favHigh ? pnlHi : pnlLo, sep: Math.abs(pnlHi - pnlLo), metSep: Math.abs(pHi - pLo) };
    }).sort((a, b) => b.metSep - a.metSep);
    console.log(`\n${title} (median split; base ${f1(baseP)}%; ranked by metric separation):`);
    console.log('  rank  indicator                    favorable   metric%  met-sep  avgPnL%  thresh(med)');
    rows.forEach((r, i) => console.log(
      `  ${String(i + 1).padStart(2)}.  ${(r.ind.fx + ' ' + r.ind.name).padEnd(28)} ${(r.favDir + ' half').padEnd(10)} ${f1(r.favP).padStart(6)}  ${f1(r.metSep).padStart(6)}  ${((r.favPnl >= 0 ? '+' : '') + f1(r.favPnl)).padStart(6)}  ${f1(r.med).padStart(8)}`));
  };

  splitRank((t) => t.win, baseWin, 'ENTRY — predicts a WINNING night');
  splitRank((t) => !t.stopped, baseSurv, 'HOLD — predicts SURVIVING to 07:00 (no stop)');

  // EXIT — dynamic in-trade triggers: fire before a stop (recall) without hitting winners (false-alarm).
  const triggers: { name: string; fire: (t: Trade, tMs: number) => boolean }[] = [
    { name: 'IV back ≥ 17:30 clock', fire: (t, tMs) => { const iv = data.ivAt(t.f.n2n, tMs), cl = data.ivAt(t.f.n2n, t.f.listing); return iv != null && cl != null && iv >= cl; } },
    { name: 'IV up-turn >1pt /1h', fire: (t, tMs) => { const iv = data.ivAt(t.f.n2n, tMs), ivp = data.ivAt(t.f.n2n, tMs - HR); return iv != null && ivp != null && iv - ivp > 1; } },
    { name: 'Speed RV1h/IV > 1.5', fire: (t, tMs) => { const iv = data.ivAt(t.f.n2n, tMs); const rv = rvAnnualizedPct(data.bars1mBetween(tMs - HR, tMs)); return iv != null && iv > 0 && rv != null && rv / iv > 1.5; } },
    { name: 'RV6h rising >15%', fire: (t, tMs) => { const rv = rvAnnualizedPct(data.bars1mBetween(tMs - 6 * HR, tMs)); return rv != null && Number.isFinite(t.feat.rv6h) && rv > t.feat.rv6h * 1.15; } },
    { name: 'Price moved >2% from entry', fire: (t, tMs) => { const s = data.entrySpot(tMs); return s != null && t.spot0 > 0 && Math.abs(s - t.spot0) / t.spot0 > 0.02; } },
  ];
  const stops = trades.filter((t) => t.stopped), winners = trades.filter((t) => t.win);
  const firesBefore = (t: Trade, endMs: number, fire: (t: Trade, tMs: number) => boolean) => {
    for (let tMs = t.entryT + 15 * MIN; tMs < endMs; tMs += 15 * MIN) if (fire(t, tMs)) return true;
    return false;
  };
  console.log(`\nEXIT — in-trade early-warning triggers (n stops=${stops.length}, winners=${winners.length}):`);
  console.log('  rank  trigger                     stop-recall%  winner-falsealarm%  net-edge');
  const exitRows = triggers.map((tr) => {
    const recall = pct(stops.filter((t) => firesBefore(t, t.stopT!, tr.fire)).length, stops.length);
    const fa = pct(winners.filter((t) => firesBefore(t, t.f.exit, tr.fire)).length, winners.length);
    return { tr, recall, fa, net: recall - fa };
  }).sort((a, b) => b.net - a.net);
  exitRows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}.  ${r.tr.name.padEnd(26)} ${f1(r.recall).padStart(8)}  ${f1(r.fa).padStart(16)}  ${((r.net >= 0 ? '+' : '') + f1(r.net)).padStart(7)}`));

  // CONSOLIDATED effectiveness = combined entry-win + hold-survive separation (how much the indicator moves the outcome).
  const cons = INDS.map((ind) => {
    const vals = trades.map((t) => ind.get(t.feat)).filter(Number.isFinite);
    const med = median(vals);
    const hi = trades.filter((t) => Number.isFinite(ind.get(t.feat)) && ind.get(t.feat) >= med);
    const lo = trades.filter((t) => Number.isFinite(ind.get(t.feat)) && ind.get(t.feat) < med);
    const winHi = pct(hi.filter((t) => t.win).length, hi.length), winLo = pct(lo.filter((t) => t.win).length, lo.length);
    const svHi = pct(hi.filter((t) => !t.stopped).length, hi.length), svLo = pct(lo.filter((t) => !t.stopped).length, lo.length);
    const pnlHi = mean(hi.map((t) => t.pnl)), pnlLo = mean(lo.map((t) => t.pnl));
    const favHigh = pnlHi >= pnlLo;
    return { ind, favDir: favHigh ? 'HIGH' : 'LOW', med, win: favHigh ? winHi : winLo, sv: favHigh ? svHi : svLo, pnl: favHigh ? pnlHi : pnlLo, score: (Math.abs(winHi - winLo) + Math.abs(svHi - svLo)) / 2 };
  }).sort((a, b) => b.score - a.score);
  console.log('\n' + '='.repeat(94));
  console.log('CONSOLIDATED EFFECTIVENESS RANK — highest-impact indicators (entry-win + hold-survive separation):');
  console.log('  rank  indicator                    favorable        Win%  Surv%  avgPnL%  effect(pts)');
  cons.forEach((r, i) => console.log(
    `  ${String(i + 1).padStart(2)}.  ${(r.ind.fx + ' ' + r.ind.name).padEnd(28)} ${(r.favDir + ' (med ' + f1(r.med) + ')').padEnd(15)} ${f1(r.win).padStart(5)}  ${f1(r.sv).padStart(5)}  ${((r.pnl >= 0 ? '+' : '') + f1(r.pnl)).padStart(6)}  ${f1(r.score).padStart(5)}`));

  // BEST MODIFICATION — engineered gates: stack top performers + use the IV 45-60 band (not a median split).
  const medOf = (g: (F: Features) => number) => median(trades.map((t) => g(t.feat)));
  const mEdge = medOf((F) => F.edge), mVel = medOf((F) => F.velPct), mRng = medOf((F) => F.range24), mTerm = medOf((F) => F.termSpread), mAdx = medOf((F) => F.adx15);
  const FILT: Record<string, (F: Features) => boolean> = {
    'edge↑': (F) => F.edge >= mEdge,
    'vel↓': (F) => F.velPct <= mVel,
    'rng↓': (F) => F.range24 <= mRng,
    'term↓': (F) => F.termSpread <= mTerm,
    'adx↑': (F) => F.adx15 >= mAdx,
    'IV45-60': (F) => F.iv >= 45 && F.iv < 60,
    'calm': (F) => F.speed < 1.5,
  };
  const combos: string[][] = [
    ['edge↑'], ['vel↓'], ['IV45-60'], ['adx↑'], ['term↓'],
    ['edge↑', 'vel↓'], ['edge↑', 'IV45-60'], ['vel↓', 'IV45-60'], ['edge↑', 'adx↑'],
    ['edge↑', 'vel↓', 'rng↓'], ['edge↑', 'vel↓', 'IV45-60'], ['edge↑', 'adx↑', 'vel↓'],
    ['edge↑', 'vel↓', 'rng↓', 'term↓'], ['IV45-60', 'edge↑', 'vel↓', 'rng↓'],
  ];
  const rows = combos.map((c) => {
    const sub = trades.filter((t) => c.every((name) => FILT[name](t.feat)));
    return { gate: c.join(' + '), n: sub.length, win: pct(sub.filter((t) => t.win).length, sub.length), sv: pct(sub.filter((t) => !t.stopped).length, sub.length), pnl: mean(sub.map((t) => t.pnl)) };
  }).filter((r) => r.n >= 12).sort((a, b) => b.pnl - a.pnl);
  console.log('\n' + '='.repeat(94));
  console.log('BEST MODIFICATION — engineered entry gates vs base (ranked by avg PnL%; n≥12 to limit overfit):');
  console.log('  rank  gate                                  n    Win%  Surv%  avgPnL%   vs base PnL');
  console.log(`  --.  BASE (all IV-turn entries)            ${String(trades.length).padStart(3)}  ${f1(baseWin).padStart(5)}  ${f1(baseSurv).padStart(5)}  ${('+' + f1(mean(trades.map((t) => t.pnl)))).padStart(6)}`);
  const basePnl = mean(trades.map((t) => t.pnl));
  rows.forEach((r, i) => console.log(
    `  ${String(i + 1).padStart(2)}.  ${r.gate.padEnd(36)} ${String(r.n).padStart(3)}  ${f1(r.win).padStart(5)}  ${f1(r.sv).padStart(5)}  ${('+' + f1(r.pnl)).padStart(6)}   ${((r.pnl - basePnl >= 0 ? '+' : '') + f1(r.pnl - basePnl)).padStart(5)}pp`));

  console.log('\nNOT BACKTESTABLE here (no archived year of data) — rank live instead:');
  console.log('  gex (dealer gamma) · skew (25Δ) · fund (funding+OI history) · liq (OKX liquidations) ·');
  console.log('  dfl (Deribit option flow) · fp (footprint) · lhm (liq heatmap) · fut (OI positioning) ·');
  console.log('  pat/cdl (chart/candle patterns) · grk (greeks) · and composite panels (ready/sig/gng/pwin/strk/legs/tip/day/ses/crush/avp).');
}

main();
