import { aggregate, atr, rsi, vwap, type Bar } from '../bot/futures.js';
import type { Condition } from './rule.js';
import { latest, valueAgo, type ClockIv, type Sample } from './series-math.js';

export type Tf = '5m' | '15m' | '1h';

/** Everything the entry conditions may look at, gathered once per check by the engine. */
export interface MarketView {
  spot: number | null;
  dvol: number | null;
  gateGo: boolean | null;
  gateReasons: string[];
  /** ATM implied volatility of the expiry the strategy trades, in vol points (null when no chain). */
  atmIv?: number | null;
  /** Total premium (USD) the sold legs would collect right now; null when the legs cannot be priced yet. */
  premium: number | null;
  /** Closed candles, oldest first: 5 minute bars (15m and 1h are built from them). */
  bars5m: readonly Bar[];
  /** Recorded ATM IV / DVOL (about a day, oldest first) for the falling conditions, and the usual IV for this clock time. */
  hist?: readonly Sample[];
  clock?: ClockIv | null;
  nowMs?: number;
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

/** The whole EMA series (same seeding as emaLast). */
function emaSeries(values: readonly number[], n: number): number[] {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const out = [e];
  for (let i = n; i < values.length; i++) { e = values[i]! * k + e * (1 - k); out.push(e); }
  return out;
}

const PER_YEAR_5M = 365 * 24 * 12;

/** Annualised realised volatility (percent) of `count` 5 minute returns ending `skip` bars before the last bar. */
export function rvPct(bars: readonly Bar[], count: number, skip = 0): number | null {
  const end = bars.length - skip;
  if (count < 2 || end - count - 1 < 0) return null;
  const rets: number[] = [];
  for (let i = end - count; i < end; i++) rets.push(Math.log(bars[i]!.c / bars[i - 1]!.c));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  return Number.isFinite(sd) ? sd * Math.sqrt(PER_YEAR_5M) * 100 : null;
}

/** The desk Edge, estimated on the server: ATM IV minus expected realised vol (half the last 24 hours, half the last five days). */
export function edgeEstimate(bars: readonly Bar[], atmIv: number | null | undefined): { edge: number; expected: number } | null {
  if (!atmIv) return null;
  const r24 = rvPct(bars, 288), r5 = rvPct(bars, Math.min(1440, bars.length - 1));
  if (r24 == null || r5 == null || bars.length < 576) return null;
  const expected = (r24 + r5) / 2;
  return { edge: atmIv - expected, expected };
}

/** MACD(12,26,9) histogram of the last bar; null without enough history. */
export function macdHist(closes: readonly number[]): number | null {
  const f = emaSeries(closes, 12), sl = emaSeries(closes, 26);
  if (!sl.length) return null;
  const off = f.length - sl.length;
  const macd = sl.map((v, i) => f[i + off]! - v);
  const sig = emaSeries(macd, 9);
  return sig.length ? macd[macd.length - 1]! - sig[sig.length - 1]! : null;
}

/** Bollinger bands (period, 2 standard deviations) on the last close. */
export function bollinger(closes: readonly number[], n = 20): { mid: number; upper: number; lower: number } | null {
  if (closes.length < n) return null;
  const w = closes.slice(-n), mid = w.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  return { mid, upper: mid + 2 * sd, lower: mid - 2 * sd };
}

/** Price move over `minutes` as a percent, from closed 5m bars. */
export function changePct(bars: readonly Bar[], minutes: number): number | null {
  const k = Math.max(1, Math.round(minutes / 5));
  if (bars.length <= k) return null;
  const a = bars[bars.length - 1 - k]!.c, b = bars[bars.length - 1]!.c;
  return a > 0 ? ((b - a) / a) * 100 : null;
}

/** Speed vs IV: the move over `minutes` divided by the move the ATM IV implies for that time (1 sigma = IV x sqrt(t / year)). */
export function speedVsIv(bars: readonly Bar[], atmIv: number | null | undefined, minutes: number): number | null {
  const ch = changePct(bars, minutes);
  if (ch == null || !atmIv || atmIv <= 0) return null;
  const sigmaPct = atmIv * Math.sqrt(minutes / (365 * 24 * 60));
  return Math.abs(ch) / sigmaPct;
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
    case 'adx_falling': {
      const bs = barsFor(v, c.tf), k = c.bars ?? 3, now = adxLast(bs, 14), prev = adxLast(bs.slice(0, bs.length - k), 14);
      return { label: `ADX ${c.tf} below ${c.value} and falling (vs ${k} bars ago)`, ok: now != null && prev != null && now < c.value && now < prev, now: now == null || prev == null ? 'no data' : `ADX ${now.toFixed(1)}, was ${prev.toFixed(1)}` };
    }
    case 'atmiv_falling':
    case 'dvol_falling': {
      const key = c.type === 'atmiv_falling' ? 'atmIv' : 'dvol', name = key === 'atmIv' ? 'ATM IV' : 'DVOL', h = v.hist ?? [], t = v.nowMs ?? Date.now();
      const now = key === 'dvol' && v.dvol != null ? v.dvol : latest(h, key), ago = valueAgo(h, key, t, c.minutes), drop = c.minDrop ?? 0.2;
      return { label: `${name} falling over ${c.minutes} min (down at least ${drop} pt)`, ok: now != null && ago != null && now <= ago - drop, now: now == null ? 'no data' : ago == null ? `${name} ${now.toFixed(1)}, no ${c.minutes} min history yet` : `${name} ${now.toFixed(1)}, ${ago.toFixed(1)} ${c.minutes} min ago` };
    }
    case 'rsi_falling': {
      const bs = barsFor(v, c.tf), k = c.bars ?? 3, now = rsi(closesOf(bs), 14), prev = rsi(closesOf(bs.slice(0, bs.length - k)), 14), drop = c.minDrop ?? 1;
      return { label: `RSI ${c.tf} falling (down at least ${drop} over ${k} bars)`, ok: now != null && prev != null && now <= prev - drop, now: now == null || prev == null ? 'no data' : `RSI ${now.toFixed(1)}, was ${prev.toFixed(1)}` };
    }
    case 'rv_falling': {
      const m = c.minutes ?? 60, k = Math.max(3, Math.round(m / 5)), now = rvPct(v.bars5m, k), prev = rvPct(v.bars5m, k, k);
      return { label: `Realised vol falling (last ${m} min below the ${m} min before)`, ok: now != null && prev != null && now <= prev * 0.95, now: now == null || prev == null ? 'no data' : `RV ${now.toFixed(1)}, before ${prev.toFixed(1)}` };
    }
    case 'ivclock': {
      const ck = v.clock;
      const cur = ck ? (ck.source === 'ATM IV' ? v.atmIv : v.dvol) : null;
      const diff = ck && cur != null ? cur - ck.value : null;
      return { label: `Tonight IV ${c.op === 'above' ? 'above' : 'below'} its clock path by ${c.points} pt`, ok: diff != null && (c.op === 'above' ? diff >= c.points : diff <= -c.points), now: ck == null ? 'no clock history yet' : diff == null ? 'no data' : `${ck.source} ${diff >= 0 ? '+' : ''}${diff.toFixed(1)} vs usual ${ck.value.toFixed(1)} (${ck.days} days)` };
    }
    case 'edge': {
      const e = edgeEstimate(v.bars5m, v.atmIv);
      return { label: `Edge between ${c.low} and ${c.high} pts`, ok: e != null && e.edge >= c.low && e.edge <= c.high, now: e == null ? 'no data' : `Edge ${e.edge >= 0 ? '+' : ''}${e.edge.toFixed(1)} (IV ${v.atmIv!.toFixed(1)} minus expected RV ${e.expected.toFixed(1)})` };
    }
    case 'atmiv':
      return { label: `ATM IV ${c.op} ${c.value}`, ok: v.atmIv != null && test(c.op, v.atmIv, c.value), now: `ATM IV ${fmt(v.atmIv ?? null)}` };
    case 'speed': {
      const m = c.minutes ?? 60, r = speedVsIv(v.bars5m, v.atmIv, m);
      return { label: `Speed vs IV (${m} min) ${c.op} ${c.value}`, ok: r != null && test(c.op, r, c.value), now: r == null ? 'no data' : `${r.toFixed(2)}x implied` };
    }
    case 'macd': {
      const h = macdHist(closesOf(barsFor(v, c.tf)));
      return { label: `MACD ${c.tf} ${c.state}`, ok: h != null && (c.state === 'bullish' ? h > 0 : h < 0), now: h == null ? 'no data' : `histogram ${h.toFixed(1)}` };
    }
    case 'bb': {
      const cl = closesOf(barsFor(v, c.tf)), b = bollinger(cl, c.period ?? 20), last = cl[cl.length - 1];
      const ok = b != null && last != null && (c.state === 'above_upper' ? last > b.upper : c.state === 'below_lower' ? last < b.lower : last <= b.upper && last >= b.lower);
      return { label: `Price ${({ above_upper: 'above the upper', below_lower: 'below the lower', inside: 'inside the' } as const)[c.state]} Bollinger band (${c.tf})`, ok, now: b && last != null ? `${last.toFixed(0)} in ${b.lower.toFixed(0)}-${b.upper.toFixed(0)}` : 'no data' };
    }
    case 'atr': {
      const bs = barsFor(v, c.tf), a = atr(bs, c.period ?? 14), last = bs[bs.length - 1]?.c;
      const pct = a != null && last ? (a / last) * 100 : null;
      return { label: `ATR ${c.tf} ${c.op} ${c.pct}% of price`, ok: pct != null && test(c.op, pct, c.pct), now: pct == null ? 'no data' : `ATR ${pct.toFixed(2)}%` };
    }
    case 'vwap': {
      const day = v.bars5m.slice(-288), w = vwap(day), last = v.bars5m[v.bars5m.length - 1]?.c;
      return { label: `Price ${c.state} VWAP (last 24h)`, ok: w != null && last != null && (c.state === 'above' ? last > w : last < w), now: w == null || last == null ? 'no data' : `${last.toFixed(0)} vs ${w.toFixed(0)}` };
    }
    case 'change': {
      const ch = changePct(v.bars5m, c.minutes);
      return { label: `Price change over ${c.minutes} min ${c.op} ${c.pct}%`, ok: ch != null && test(c.op, ch, c.pct), now: ch == null ? 'no data' : `${ch.toFixed(2)}%` };
    }
  }
}

/** All conditions must pass. No conditions means the entry is unconditional inside its window. */
export function evalConditions(list: readonly Condition[], v: MarketView): { met: boolean; results: ConditionResult[] } {
  const results = list.map((c) => evalCondition(c, v));
  return { met: results.every((r) => r.ok), results };
}
