import { aggregate, rsi, type Bar } from '../bot/futures.js';
import type { Condition } from './rule.js';

export type Tf = '5m' | '15m' | '1h';

/** Everything the entry conditions may look at, gathered once per check by the engine. */
export interface MarketView {
  spot: number | null;
  dvol: number | null;
  gateGo: boolean | null;
  gateReasons: string[];
  /** Total premium (USD) the sold legs would collect right now; null when the legs cannot be priced yet. */
  premium: number | null;
  /** Closed candles, oldest first: 5 minute bars (15m and 1h are built from them). */
  bars5m: readonly Bar[];
}

export interface ConditionResult {
  label: string;
  ok: boolean;
  /** What the market shows right now, for the panel ("RSI 41.2"). */
  now: string;
}

const closesOf = (bars: readonly Bar[]) => bars.map((b) => b.c);
const barsFor = (v: MarketView, tf: Tf): Bar[] => (tf === '5m' ? [...v.bars5m] : aggregate(v.bars5m, tf === '15m' ? 15 : 60));

/** Exponential moving average of the last value; null without enough history. */
export function emaLast(values: readonly number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i]! * k + e * (1 - k);
  return e;
}

/** Wilder's ADX of the last bar; null without 2n bars. */
export function adxLast(bars: readonly Bar[], n = 14): number | null {
  if (bars.length < 2 * n + 1) return null;
  let tr = 0, pdm = 0, ndm = 0;
  const dx: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!, p = bars[i - 1]!;
    const up = b.h - p.h, dn = p.l - b.l;
    const t = Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
    const pd = up > dn && up > 0 ? up : 0, nd = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; pdm += pd; ndm += nd; } else { tr = tr - tr / n + t; pdm = pdm - pdm / n + pd; ndm = ndm - ndm / n + nd; }
    if (i >= n) {
      const pdi = tr ? (100 * pdm) / tr : 0, ndi = tr ? (100 * ndm) / tr : 0;
      dx.push(pdi + ndi ? (100 * Math.abs(pdi - ndi)) / (pdi + ndi) : 0);
    }
  }
  if (dx.length < n) return null;
  let a = dx.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i]!) / n;
  return a;
}

const test = (op: '<' | '>', a: number, b: number) => (op === '<' ? a < b : a > b);
const fmt = (n: number | null, d = 1) => (n == null ? 'no data' : n.toFixed(d));

export function evalCondition(c: Condition, v: MarketView): ConditionResult {
  switch (c.type) {
    case 'gate':
      return { label: 'Desk gate says GO', ok: v.gateGo === true, now: v.gateGo == null ? 'no data' : v.gateGo ? 'GO' : `WAIT (${v.gateReasons.join('; ') || 'not clear'})` };
    case 'dvol':
      return { label: `DVOL ${c.op} ${c.value}`, ok: v.dvol != null && test(c.op, v.dvol, c.value), now: `DVOL ${fmt(v.dvol)}` };
    case 'spot':
      return { label: `Spot ${c.op} ${c.value}`, ok: v.spot != null && test(c.op, v.spot, c.value), now: `spot ${fmt(v.spot, 0)}` };
    case 'premium':
      return { label: `Premium collected at least $${c.value}`, ok: v.premium != null && v.premium >= c.value, now: v.premium == null ? 'no price yet' : `$${v.premium.toFixed(2)}` };
    case 'rsi': {
      const r = rsi(closesOf(barsFor(v, c.tf)), c.period ?? 14);
      return { label: `RSI ${c.tf} ${c.op} ${c.value}`, ok: r != null && test(c.op, r, c.value), now: `RSI ${fmt(r)}` };
    }
    case 'adx': {
      const a = adxLast(barsFor(v, c.tf), c.period ?? 14);
      return { label: `ADX ${c.tf} ${c.op} ${c.value}`, ok: a != null && test(c.op, a, c.value), now: `ADX ${fmt(a)}` };
    }
    case 'ema': {
      const cl = closesOf(barsFor(v, c.tf));
      const f = emaLast(cl, c.fast), s = emaLast(cl, c.slow);
      const ok = f != null && s != null && (c.state === 'above' ? f > s : f < s);
      return { label: `EMA ${c.fast} ${c.state} EMA ${c.slow} (${c.tf})`, ok, now: f == null || s == null ? 'no data' : `${f.toFixed(0)} vs ${s.toFixed(0)}` };
    }
  }
}

/** All conditions must pass. No conditions means the entry is unconditional inside its window. */
export function evalConditions(list: readonly Condition[], v: MarketView): { met: boolean; results: ConditionResult[] } {
  const results = list.map((c) => evalCondition(c, v));
  return { met: results.every((r) => r.ok), results };
}
