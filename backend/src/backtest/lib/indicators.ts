/**
 * Indicator battery computed AT a given entry time for a session (no look-ahead).
 * Formulas are the exact backend/Volatility-Desk definitions:
 *  - ADX(14) Wilder   (stage1_backtest.ts adxSeries)
 *  - RSI(14) Wilder    (index.html rsiCalc)
 *  - session VWAP + σ  (index.html vwapCalc: tp=(h+l+c)/3)
 *  - Speed=RV1h/IV, Edge=IV-RV24, Range24, IV-vs-Clock, IV-turn, term spread, VoV, DVOL.
 * Sparse/aggregate series (skew/GEX/flow) are intentionally omitted here (data-limited;
 * see plan) and handled separately where coverage allows.
 */
import { HR, MIN } from './frame.js';
import type { Frame } from './frame.js';
import type { BacktestData, Bar } from '../data/load.js';
import { rvAnnualizedPct } from './signals.js';
import { std } from './stats.js';

function adxLast(bars: Bar[], n = 14): number | null {
  if (bars.length < n * 3) return null;
  let tr = 0, pdm = 0, ndm = 0, adx: number | null = null;
  const dxs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1], b = bars[i];
    const up = b.h - a.h, dn = a.l - b.l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    const t = Math.max(b.h - b.l, Math.abs(b.h - a.c), Math.abs(b.l - a.c));
    if (i <= n) { tr += t; pdm += p; ndm += m; if (i < n) continue; }
    else { tr = tr - tr / n + t; pdm = pdm - pdm / n + p; ndm = ndm - ndm / n + m; }
    const pdi = tr > 0 ? (100 * pdm) / tr : 0, ndi = tr > 0 ? (100 * ndm) / tr : 0;
    const dx = pdi + ndi > 0 ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0;
    if (adx == null) { dxs.push(dx); if (dxs.length < n) continue; adx = dxs.reduce((s, v) => s + v, 0) / dxs.length; }
    else adx = (adx * (n - 1) + dx) / n;
  }
  return adx;
}

function rsiLast(closes: number[], n = 14): number | null {
  if (closes.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  const rs = l === 0 ? 100 : g / l;
  return 100 - 100 / (1 + rs);
}

function sessionVwap(bars: Bar[]): { vwap: number; sd: number } | null {
  let pv = 0, vv = 0, tp2v = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v; vv += b.v; tp2v += tp * tp * b.v;
  }
  if (vv <= 0) return null;
  const vwap = pv / vv;
  return { vwap, sd: Math.sqrt(Math.max(0, tp2v / vv - vwap * vwap)) };
}

export interface Features {
  speed: number; rv1h: number; rv6h: number; rv24h: number;
  adx15: number; rsi15: number;
  iv: number; ivMinusClock: number; ivTurnPct: number;
  edge: number; range24: number; termSpread: number;
  vovCont: number; dvol: number; dvolSlope: number;
  velPct: number; vwapSigma: number;
  // booleans at backend thresholds
  belowClock: boolean; vovSmooth: boolean;
}

const NA = NaN;

export function computeFeatures(data: BacktestData, f: Frame, entryT: number): Features {
  const iv = data.ivAt(f.n2n, entryT) ?? NA;
  const ivListing = data.ivAt(f.n2n, f.listing) ?? iv;
  const iv1h = data.ivAt(f.n2n, entryT - HR) ?? iv;
  const iv3h = data.ivAt(f.n2n, entryT - 3 * HR) ?? iv;
  const peak = Math.max(...data.ivWindow(f.n2n, f.open, entryT).map(([, v]) => v), iv);

  const spot = data.entrySpot(entryT) ?? (data.bars1mBetween(entryT - MIN, entryT).slice(-1)[0]?.c ?? NA);
  const spot24 = data.entrySpot(entryT - 24 * HR) ?? spot;
  const spot1 = data.entrySpot(entryT - HR) ?? spot;

  const rv1h = rvAnnualizedPct(data.bars1mBetween(entryT - HR, entryT)) ?? NA;
  const rv6h = rvAnnualizedPct(data.bars1mBetween(entryT - 6 * HR, entryT)) ?? NA;
  const rv24h = rvAnnualizedPct(data.bars1mBetween(entryT - 24 * HR, entryT)) ?? NA;

  const bars15 = data.bars15mBetween(entryT - 120 * 15 * MIN, entryT); // ~30h of 15m
  const adx15 = adxLast(bars15) ?? NA;
  const rsi15 = rsiLast(bars15.map((b) => b.c)) ?? NA;

  const vw = sessionVwap(data.bars15mBetween(f.open, entryT));
  const vwapSigma = vw && vw.sd > 0 ? (spot - vw.vwap) / vw.sd : NA;

  const ivCur = data.ivAt(f.cur, entryT);
  const termSpread = ivCur != null ? ivCur - iv : NA;

  const ivInc = data.ivWindow(f.n2n, entryT - 3 * HR, entryT).map(([, v]) => v);
  const diffs: number[] = [];
  for (let i = 1; i < ivInc.length; i++) diffs.push(ivInc[i] - ivInc[i - 1]);

  const dvol = data.dvolAt(entryT) ?? NA;
  const dvol6 = data.dvolAt(entryT - 6 * HR) ?? dvol;

  return {
    speed: iv > 0 ? rv1h / iv : NA,
    rv1h, rv6h, rv24h,
    adx15, rsi15,
    iv,
    ivMinusClock: iv - ivListing,
    ivTurnPct: peak > 0 ? ((peak - iv) / peak) * 100 : NA,
    edge: iv - rv24h,
    range24: spot24 > 0 ? (Math.abs(spot - spot24) / spot24) * 100 : NA,
    termSpread,
    vovCont: std(diffs),
    dvol,
    dvolSlope: dvol - dvol6,
    velPct: spot1 > 0 ? (Math.abs(spot - spot1) / spot1) * 100 : NA,
    vwapSigma,
    belowClock: iv < ivListing,
    vovSmooth: iv < iv1h && Math.abs(iv - iv3h) < 1.5,
  };
}
