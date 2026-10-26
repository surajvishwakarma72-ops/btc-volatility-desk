import { atr, rsi, vwap, type Bar } from '../bot/futures.js';
import { adxLast, bollinger, emaLast, macdHist } from './conditions.js';
import type { Condition } from './rule.js';

/**
 * Which indicators have actually worked on the recent past, for futures (does the signal point the right way?) and for selling
 * options (does the condition come before a calm market?). Pure maths over 15 minute candles: no network, no model.
 *
 * This is a look back at recorded prices. It is in-sample, it ignores fees and slippage, and a ranking from a few weeks of data
 * can reverse. It suggests what to test, it does not promise what will happen.
 */
export interface FutureScore {
  id: string;
  label: string;
  n: number;
  /** Share of signals whose price move over the horizon went the signalled way, 0..1. */
  winRate: number;
  /** Average move over the horizon in the signalled direction, percent. */
  avgPct: number;
  /** avg / standard error, with overlapping signals discounted. Above 2 is worth looking at, below 1 is noise. */
  score: number;
  /** What the latest bar says now: 1 long, -1 short, 0 nothing. */
  now: 1 | -1 | 0;
  long: Condition | null;
  short: Condition | null;
}

export interface OptionScore {
  id: string;
  label: string;
  n: number;
  /** Average high-low range over the next 8 hours when the condition held, percent of price. */
  avgRange: number;
  baseline: number;
  /** How much calmer than average the following hours were, percent (positive is better for a seller). */
  calmerPct: number;
  /** Share of cases where the next 8 hours stayed inside a 2 percent range. */
  calmRate: number;
  baselineCalmRate: number;
  now: boolean;
  condition: Condition | null;
}

export interface Insights {
  at: number;
  bars: number;
  from: number | null;
  to: number | null;
  futures: FutureScore[];
  options: OptionScore[];
  note: string;
}

const WIN = 150;
const FUT_H = 16; // 4 hours of 15 minute bars
const OPT_H = 32; // 8 hours

type Sig = (w: Bar[]) => 1 | -1 | 0;
const closesOf = (w: readonly Bar[]) => w.map((b) => b.c);
const last = <T>(a: readonly T[]) => a[a.length - 1];

const FUT: Array<{ id: string; label: string; sig: Sig; long: Condition | null; short: Condition | null }> = [
  { id: 'rsi_revert', label: 'RSI(14) reversal: below 30 buy, above 70 sell (15 min)', sig: (w) => { const r = rsi(closesOf(w), 14); return r == null ? 0 : r < 30 ? 1 : r > 70 ? -1 : 0; }, long: { type: 'rsi', tf: '15m', op: '<', value: 30 }, short: { type: 'rsi', tf: '15m', op: '>', value: 70 } },
  { id: 'rsi_trend', label: 'RSI(14) trend: above 60 buy, below 40 sell (15 min)', sig: (w) => { const r = rsi(closesOf(w), 14); return r == null ? 0 : r > 60 ? 1 : r < 40 ? -1 : 0; }, long: { type: 'rsi', tf: '15m', op: '>', value: 60 }, short: { type: 'rsi', tf: '15m', op: '<', value: 40 } },
  { id: 'ema_9_21', label: 'EMA 9 vs EMA 21 (15 min)', sig: (w) => { const c = closesOf(w), f = emaLast(c, 9), s = emaLast(c, 21); return f == null || s == null ? 0 : f > s ? 1 : -1; }, long: { type: 'ema', tf: '15m', fast: 9, slow: 21, state: 'above' }, short: { type: 'ema', tf: '15m', fast: 9, slow: 21, state: 'below' } },
  { id: 'macd', label: 'MACD histogram sign (15 min)', sig: (w) => { const h = macdHist(closesOf(w)); return h == null ? 0 : h > 0 ? 1 : -1; }, long: { type: 'macd', tf: '15m', state: 'bullish' }, short: { type: 'macd', tf: '15m', state: 'bearish' } },
  { id: 'bb_break', label: 'Bollinger breakout: close outside the band, trade with it (15 min)', sig: (w) => { const b = bollinger(closesOf(w)), c = last(w)?.c; return !b || c == null ? 0 : c > b.upper ? 1 : c < b.lower ? -1 : 0; }, long: { type: 'bb', tf: '15m', state: 'above_upper' }, short: { type: 'bb', tf: '15m', state: 'below_lower' } },
  { id: 'bb_revert', label: 'Bollinger reversal: close outside the band, trade against it (15 min)', sig: (w) => { const b = bollinger(closesOf(w)), c = last(w)?.c; return !b || c == null ? 0 : c > b.upper ? -1 : c < b.lower ? 1 : 0; }, long: { type: 'bb', tf: '15m', state: 'below_lower' }, short: { type: 'bb', tf: '15m', state: 'above_upper' } },
  { id: 'vwap', label: 'Price above / below the 24 hour VWAP', sig: (w) => { const v = vwap(w.slice(-96)), c = last(w)?.c; return v == null || c == null ? 0 : c > v ? 1 : -1; }, long: { type: 'vwap', state: 'above' }, short: { type: 'vwap', state: 'below' } },
  { id: 'momentum_4h', label: 'Momentum: moved more than 0.5% in the last 4 hours', sig: (w) => { if (w.length <= FUT_H) return 0; const a = w[w.length - 1 - FUT_H]!.c, b = last(w)!.c, ch = ((b - a) / a) * 100; return ch > 0.5 ? 1 : ch < -0.5 ? -1 : 0; }, long: { type: 'change', op: '>', pct: 0.5, minutes: 240 }, short: { type: 'change', op: '<', pct: -0.5, minutes: 240 } },
  { id: 'adx_ema', label: 'Trend filter: ADX above 25 and EMA 9 vs 21 agree (15 min)', sig: (w) => { const a = adxLast(w, 14), c = closesOf(w), f = emaLast(c, 9), s = emaLast(c, 21); return a == null || f == null || s == null || a < 25 ? 0 : f > s ? 1 : -1; }, long: null, short: null },
];

const rangePct = (w: readonly Bar[]) => {
  const hi = Math.max(...w.map((b) => b.h)), lo = Math.min(...w.map((b) => b.l)), c = w[0]!.c;
  return c > 0 ? ((hi - lo) / c) * 100 : 0;
};

const OPT: Array<{ id: string; label: string; test: (w: Bar[]) => boolean | null; condition: Condition | null }> = [
  { id: 'adx20', label: 'ADX(14) below 20: no trend (15 min)', test: (w) => { const a = adxLast(w, 14); return a == null ? null : a < 20; }, condition: { type: 'adx', tf: '15m', op: '<', value: 20 } },
  { id: 'adx25', label: 'ADX(14) below 25 (15 min)', test: (w) => { const a = adxLast(w, 14); return a == null ? null : a < 25; }, condition: { type: 'adx', tf: '15m', op: '<', value: 25 } },
  { id: 'rsi_mid', label: 'RSI(14) between 40 and 60 (15 min)', test: (w) => { const r = rsi(closesOf(w), 14); return r == null ? null : r >= 40 && r <= 60; }, condition: null },
  { id: 'bb_inside', label: 'Price inside its Bollinger band (15 min)', test: (w) => { const b = bollinger(closesOf(w)), c = last(w)?.c; return !b || c == null ? null : c <= b.upper && c >= b.lower; }, condition: { type: 'bb', tf: '15m', state: 'inside' } },
  { id: 'atr_low', label: 'ATR(14) below 0.25% of price (15 min)', test: (w) => { const a = atr(w, 14), c = last(w)?.c; return a == null || !c ? null : (a / c) * 100 < 0.25; }, condition: { type: 'atr', tf: '15m', op: '<', pct: 0.25 } },
  { id: 'quiet_4h', label: 'Price moved less than 0.5% in the last 4 hours', test: (w) => { if (w.length <= FUT_H) return null; const a = w[w.length - 1 - FUT_H]!.c, b = last(w)!.c; return Math.abs(((b - a) / a) * 100) < 0.5; }, condition: null },
  { id: 'near_vwap', label: 'Price within 0.3% of the 24 hour VWAP', test: (w) => { const v = vwap(w.slice(-96)), c = last(w)?.c; return v == null || c == null ? null : Math.abs((c - v) / v) * 100 < 0.3; }, condition: null },
  { id: 'ema_tight', label: 'EMA 9 and EMA 21 within 0.15% of each other (15 min)', test: (w) => { const c = closesOf(w), f = emaLast(c, 9), s = emaLast(c, 21); return f == null || s == null ? null : (Math.abs(f - s) / s) * 100 < 0.15; }, condition: null },
];

const mean = (a: readonly number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Rank the futures signals and the option-selling filters on 15 minute bars (oldest first). */
export function rankIndicators(bars: readonly Bar[], minSignals = 40): Insights {
  const futN: Record<string, number[]> = {};
  const futNow: Record<string, 1 | -1 | 0> = {};
  const optHit: Record<string, number[]> = {};
  const optNow: Record<string, boolean> = {};
  const all: number[] = [];
  for (const f of FUT) futN[f.id] = [];
  for (const o of OPT) optHit[o.id] = [];
  const total = bars.length;
  for (let i = WIN; i < total; i++) {
    const w = bars.slice(i - WIN + 1, i + 1) as Bar[];
    const atEnd = i === total - 1;
    const fwdF = i + FUT_H < total ? (bars[i + FUT_H]!.c - bars[i]!.c) / bars[i]!.c * 100 : null;
    const fwdO = i + OPT_H < total ? rangePct(bars.slice(i, i + OPT_H + 1)) : null;
    if (fwdO != null) all.push(fwdO);
    for (const f of FUT) {
      const s = f.sig(w);
      if (atEnd) futNow[f.id] = s;
      if (s !== 0 && fwdF != null) futN[f.id]!.push(s * fwdF);
    }
    for (const o of OPT) {
      const t = o.test(w);
      if (atEnd) optNow[o.id] = t === true;
      if (t === true && fwdO != null) optHit[o.id]!.push(fwdO);
    }
  }
  const baseline = mean(all), baselineCalm = all.length ? all.filter((x) => x < 2).length / all.length : 0;
  const futures: FutureScore[] = FUT.map((f) => {
    const v = futN[f.id]!, n = v.length, avg = mean(v);
    const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1)) : 0;
    // overlapping 4 hour windows are not independent: count about one signal in every FUT_H
    const eff = Math.max(1, n / FUT_H);
    return { id: f.id, label: f.label, n, winRate: n ? v.filter((x) => x > 0).length / n : 0, avgPct: avg, score: sd > 0 ? avg / (sd / Math.sqrt(eff)) : 0, now: futNow[f.id] ?? 0, long: f.long, short: f.short };
  }).filter((f) => f.n >= minSignals).sort((a, b) => b.score - a.score);
  const options: OptionScore[] = OPT.map((o) => {
    const v = optHit[o.id]!, n = v.length, avg = mean(v);
    return { id: o.id, label: o.label, n, avgRange: avg, baseline, calmerPct: baseline > 0 ? ((baseline - avg) / baseline) * 100 : 0, calmRate: n ? v.filter((x) => x < 2).length / n : 0, baselineCalmRate: baselineCalm, now: optNow[o.id] ?? false, condition: o.condition };
  }).filter((o) => o.n >= minSignals).sort((a, b) => b.calmerPct - a.calmerPct);
  return {
    at: Date.now(), bars: total, from: total ? bars[0]!.t : null, to: total ? bars[total - 1]!.t : null, futures, options,
    note: 'A look back at recorded prices: in-sample, no fees, no slippage. Use it to pick what to test, not as a promise. The ranking is recomputed from fresh data every few hours.',
  };
}
