import { chooseLeverage, futuresLots } from './sizing.js';
import { feeToRiskOk, futuresFee } from './costs.js';
import { istDay, sessionBounds, type SessionName } from './sessions.js';

/**
 * Directional BTC perpetual strategies (pure; shared by replay and the live paper engine):
 *  - FUT_SWEEP_LDN: London sweeps the Asia high/low and reclaims it, with confirmation.
 *  - FUT_SWEEP_NY:  New York sweeps the London high/low and reclaims it, with confirmation.
 *  - FUT_SIGNAL:    confluence of price-action votes at any time of day.
 * A sweep alone never triggers: it needs at least `minConfirm` confirmations. Size follows the
 * stop distance so a stop-out costs about `riskUsd`; wider stops get fewer lots.
 */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type FuturesStrategy = 'FUT_SWEEP_LDN' | 'FUT_SWEEP_NY' | 'FUT_SIGNAL';
export type Dir = 'long' | 'short';

export interface FuturesConfig {
  riskUsd: number;
  maxLots: number;
  contractValue: number;
  maxLeverage: number;
  /** Stop must stay within this fraction of the distance to liquidation. */
  liqFraction: number;
  takerRate: number;
  makerRate: number;
  /** Skip when the round-trip fee exceeds this fraction of the risked amount. */
  maxFeeToRisk: number;
  targetR: number;
  breakevenR: number;
  trailStartR: number;
  maxHoldMin: number;
  /** Extra stop distance beyond the structure level, as a fraction of the 15m ATR. */
  stopBufferAtr: number;
  minStopUsd: number;
  maxStopUsd: number;
  /** Confirmations needed (of 4 price confirmations) for sweep trades. */
  minConfirm: number;
  /** Price votes needed for FUT_SIGNAL. */
  minVotes: number;
  /** Minutes the sweep window stays open after the session starts. */
  sweepWindowMin: number;
  /** Entry slippage in USD (adverse), and stop slippage. */
  entrySlipUsd: number;
  stopSlipUsd: number;
  signalCooldownMin: number;
  signalMaxPerDay: number;
}

export const DEFAULT_FUTURES: FuturesConfig = {
  riskUsd: 5,
  maxLots: 25,
  contractValue: 0.001,
  maxLeverage: 50,
  liqFraction: 0.4,
  takerRate: 0.0005,
  makerRate: 0.0002,
  maxFeeToRisk: 0.5,
  targetR: 2,
  breakevenR: 1,
  trailStartR: 1.5,
  maxHoldMin: 12 * 60,
  stopBufferAtr: 0.15,
  minStopUsd: 60,
  maxStopUsd: 900,
  minConfirm: 2,
  minVotes: 2,
  sweepWindowMin: 240,
  entrySlipUsd: 0.5,
  stopSlipUsd: 1,
  signalCooldownMin: 240,
  signalMaxPerDay: 3,
};

// ---------- indicators ----------

/** Aggregate 1m bars into `minutes`-minute bars aligned to the epoch. */
export function aggregate(bars: readonly Bar[], minutes: number): Bar[] {
  const span = minutes * 60_000;
  const out: Bar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.t / span) * span;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

export function rsi(closes: readonly number[], n = 14): number | null {
  if (closes.length <= n) return null;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) g += d;
    else l -= d;
  }
  g /= n;
  l /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

export function atr(bars: readonly Bar[], n = 14): number | null {
  if (bars.length <= n) return null;
  let a = 0;
  for (let i = 1; i <= n; i++) a += Math.max(bars[i]!.h - bars[i]!.l, Math.abs(bars[i]!.h - bars[i - 1]!.c), Math.abs(bars[i]!.l - bars[i - 1]!.c));
  a /= n;
  for (let i = n + 1; i < bars.length; i++) {
    const tr = Math.max(bars[i]!.h - bars[i]!.l, Math.abs(bars[i]!.h - bars[i - 1]!.c), Math.abs(bars[i]!.l - bars[i - 1]!.c));
    a = (a * (n - 1) + tr) / n;
  }
  return a;
}

export function vwap(bars: readonly Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    v += b.v;
  }
  return v > 0 ? pv / v : null;
}

const median = (a: number[]): number => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface RangeHL {
  high: number;
  low: number;
  from: number;
  to: number;
}

export function rangeOf(bars: readonly Bar[], from: number, to: number): RangeHL | null {
  let high = -Infinity;
  let low = Infinity;
  let n = 0;
  for (const b of bars) {
    if (b.t < from || b.t >= to) continue;
    high = Math.max(high, b.h);
    low = Math.min(low, b.l);
    n++;
  }
  return n ? { high, low, from, to } : null;
}

// ---------- signals ----------

export interface Confirmation {
  name: string;
  ok: boolean;
  detail: string;
}

export interface FuturesSignal {
  strategy: FuturesStrategy;
  dir: Dir;
  /** Bar close time (epoch ms) when the signal fired. */
  at: number;
  entry: number;
  /** Structure level the stop sits beyond (sweep extreme etc.). */
  extreme: number;
  atr15: number;
  confirmations: Confirmation[];
  score: number;
  note: string;
}

/**
 * Four price-only confirmations for a reclaimed sweep. Funding/OI/CVD/liquidation crowding is
 * layered on live (see `extras`) but cannot be replayed because that history is not archived.
 */
export function sweepConfirmations(bar: Bar, prior: readonly Bar[], sessionBars: readonly Bar[], dir: Dir, closes: readonly number[]): Confirmation[] {
  const range = bar.h - bar.l || 1;
  const wick = dir === 'short' ? bar.h - Math.max(bar.o, bar.c) : Math.min(bar.o, bar.c) - bar.l;
  const wickShare = wick / range;
  const medV = median(prior.slice(-24).map((b) => b.v));
  const r = rsi(closes);
  const vw = vwap(sessionBars);
  return [
    { name: 'wick', ok: wickShare >= 0.5, detail: `rejection wick ${(wickShare * 100).toFixed(0)}% of the bar` },
    { name: 'volume', ok: medV > 0 && bar.v >= 1.5 * medV, detail: `volume ${(medV > 0 ? bar.v / medV : 0).toFixed(1)}x the 24-bar median` },
    { name: 'rsi', ok: r != null && (dir === 'short' ? r >= 62 : r <= 38), detail: `RSI ${r == null ? 'n/a' : r.toFixed(0)}` },
    { name: 'vwap', ok: vw != null && (dir === 'short' ? bar.c >= vw : bar.c <= vw), detail: vw == null ? 'VWAP n/a' : `close ${dir === 'short' ? 'above' : 'below'} session VWAP ${vw.toFixed(0)}` },
  ];
}

export interface DetectInput {
  /** 1m bars up to and including the current closed minute, chronological. */
  bars1m: readonly Bar[];
  nowMs: number;
  cfg?: Partial<FuturesConfig>;
  /** Optional live-only confirmations, appended to the price confirmations. */
  extras?: Confirmation[];
}

/**
 * A reclaim fires on exactly one bar per sweep:
 *  A) this bar pokes beyond the level and closes back inside, or
 *  B) the previous bar closed beyond the level (still outside) and this bar closes back inside.
 */
function reclaimBar(b5: readonly Bar[], i: number, level: number, side: 'high' | 'low'): { ok: boolean; extreme: number } {
  const bar = b5[i]!;
  const prev = i > 0 ? b5[i - 1]! : null;
  if (side === 'high') {
    if (bar.h > level && bar.c < level) return { ok: true, extreme: bar.h };
    if (prev && prev.c > level && bar.c < level) return { ok: true, extreme: Math.max(prev.h, bar.h) };
    return { ok: false, extreme: bar.h };
  }
  if (bar.l < level && bar.c > level) return { ok: true, extreme: bar.l };
  if (prev && prev.c < level && bar.c > level) return { ok: true, extreme: Math.min(prev.l, bar.l) };
  return { ok: false, extreme: bar.l };
}

/**
 * Detect a London or New York sweep at the latest closed 5m bar. Returns at most one signal and
 * only once per session (the caller tracks that), never without enough confirmations.
 */
export function detectSessionSweep(strategy: 'FUT_SWEEP_LDN' | 'FUT_SWEEP_NY', inp: DetectInput): FuturesSignal | null {
  const cfg = { ...DEFAULT_FUTURES, ...inp.cfg };
  const { bars1m, nowMs } = inp;
  if (bars1m.length < 400) return null;
  const day = istDay(nowMs);
  const attack: SessionName = strategy === 'FUT_SWEEP_LDN' ? 'LONDON' : 'NEW YORK';
  const base: SessionName = strategy === 'FUT_SWEEP_LDN' ? 'ASIA' : 'LONDON';
  // The session that is running may have started on yesterday's IST day (NY crosses midnight).
  let rangeDay = day;
  let a = sessionBounds(attack, rangeDay);
  if (nowMs < a.start) {
    rangeDay = day - 1;
    a = sessionBounds(attack, rangeDay);
  }
  const rb = sessionBounds(base, rangeDay);
  if (nowMs < a.start || nowMs >= a.start + cfg.sweepWindowMin * 60_000 || nowMs >= a.end) return null;
  const range = rangeOf(bars1m, rb.start, strategy === 'FUT_SWEEP_LDN' ? sessionBounds('LONDON', rangeDay).start : sessionBounds('NEW YORK', rangeDay).start);
  if (!range) return null;

  const b5 = aggregate(bars1m.filter((b) => b.t < Math.floor(nowMs / 300_000) * 300_000), 5);
  if (b5.length < 40) return null;
  const i = b5.length - 1;
  const bar = b5[i]!;
  if (bar.t < a.start - 300_000) return null;
  const b15 = aggregate(bars1m.filter((b) => b.t < Math.floor(nowMs / 300_000) * 300_000), 15);
  const atr15 = atr(b15) ?? 0;
  if (!(atr15 > 0)) return null;

  const closes = b5.map((b) => b.c);
  const sessionBars = bars1m.filter((b) => b.t >= a.start && b.t <= bar.t + 240_000);
  for (const [side, dir] of [['high', 'short'], ['low', 'long']] as const) {
    const level = side === 'high' ? range.high : range.low;
    const rc = reclaimBar(b5, i, level, side);
    if (!rc.ok) continue;
    const conf = [...sweepConfirmations(bar, b5.slice(0, -1), sessionBars, dir, closes), ...(inp.extras ?? [])];
    const score = conf.filter((c) => c.ok).length;
    if (score < cfg.minConfirm) continue;
    return {
      strategy, dir, at: bar.t + 300_000, entry: bar.c, extreme: rc.extreme, atr15, confirmations: conf, score,
      note: `${attack} swept ${base} ${side} ${level.toFixed(0)} and reclaimed it; ${score}/${conf.length} confirmations`,
    };
  }
  return null;
}

/**
 * FUT_SIGNAL: price-action votes. A vote is +1 long / -1 short. Needs `minVotes` agreeing votes
 * and no opposing vote.
 *   V1 reclaim of the prior IST day's high/low (sweep and close back inside)
 *   V2 volume breakout beyond the prior day's range, with a strong close (momentum)
 *   V3 RSI(14, 5m) extreme (mean reversion)
 */
export function detectSignal(inp: DetectInput & { prevDay: RangeHL | null }): FuturesSignal | null {
  const cfg = { ...DEFAULT_FUTURES, ...inp.cfg };
  const { bars1m, nowMs, prevDay } = inp;
  if (!prevDay || bars1m.length < 400) return null;
  const cutoff = Math.floor(nowMs / 300_000) * 300_000;
  const b5 = aggregate(bars1m.filter((b) => b.t < cutoff), 5);
  if (b5.length < 60) return null;
  const i = b5.length - 1;
  const bar = b5[i]!;
  const b15 = aggregate(bars1m.filter((b) => b.t < cutoff), 15);
  const atr15 = atr(b15) ?? 0;
  if (!(atr15 > 0)) return null;
  const votes: Array<{ name: string; dir: Dir; detail: string; extreme: number }> = [];

  const hi = reclaimBar(b5, i, prevDay.high, 'high');
  if (hi.ok) votes.push({ name: 'prev-day-high reclaim', dir: 'short', detail: `swept ${prevDay.high.toFixed(0)} and closed back below`, extreme: hi.extreme });
  const lo = reclaimBar(b5, i, prevDay.low, 'low');
  if (lo.ok) votes.push({ name: 'prev-day-low reclaim', dir: 'long', detail: `swept ${prevDay.low.toFixed(0)} and closed back above`, extreme: lo.extreme });

  const medV = median(b5.slice(-25, -1).map((b) => b.v));
  const strong = (bar.h - bar.l) > 0 && Math.abs(bar.c - bar.o) / (bar.h - bar.l) >= 0.6;
  if (medV > 0 && bar.v >= 2 * medV && strong) {
    if (bar.c > prevDay.high && bar.c > bar.o) votes.push({ name: 'breakout up', dir: 'long', detail: `closed above ${prevDay.high.toFixed(0)} on ${(bar.v / medV).toFixed(1)}x volume`, extreme: bar.l });
    if (bar.c < prevDay.low && bar.c < bar.o) votes.push({ name: 'breakdown', dir: 'short', detail: `closed below ${prevDay.low.toFixed(0)} on ${(bar.v / medV).toFixed(1)}x volume`, extreme: bar.h });
  }

  const r = rsi(b5.map((b) => b.c));
  if (r != null && r <= 25) votes.push({ name: 'RSI oversold', dir: 'long', detail: `RSI ${r.toFixed(0)}`, extreme: Math.min(...b5.slice(-6).map((b) => b.l)) });
  if (r != null && r >= 75) votes.push({ name: 'RSI overbought', dir: 'short', detail: `RSI ${r.toFixed(0)}`, extreme: Math.max(...b5.slice(-6).map((b) => b.h)) });

  const longs = votes.filter((v) => v.dir === 'long');
  const shorts = votes.filter((v) => v.dir === 'short');
  if (longs.length && shorts.length) return null;
  const agree = longs.length ? longs : shorts;
  if (agree.length < cfg.minVotes) return null;
  const dir = agree[0]!.dir;
  const extreme = dir === 'long' ? Math.min(...agree.map((v) => v.extreme)) : Math.max(...agree.map((v) => v.extreme));
  return {
    strategy: 'FUT_SIGNAL', dir, at: bar.t + 300_000, entry: bar.c, extreme, atr15,
    confirmations: [...agree.map((v) => ({ name: v.name, ok: true, detail: v.detail })), ...(inp.extras ?? [])],
    score: agree.length, note: `${agree.length} agreeing price votes: ${agree.map((v) => v.name).join(', ')}`,
  };
}

// ---------- trade plan ----------

export interface FuturesPlan {
  dir: Dir;
  entry: number;
  stop: number;
  target: number;
  riskDist: number;
  lots: number;
  leverage: number;
  riskAtStopUsd: number;
  roundTripFeeUsd: number;
}

export type PlanResult = { ok: true; plan: FuturesPlan } | { ok: false; reason: string };

export function planTrade(sig: FuturesSignal, cfgIn: Partial<FuturesConfig> = {}): PlanResult {
  const cfg = { ...DEFAULT_FUTURES, ...cfgIn };
  const buffer = cfg.stopBufferAtr * sig.atr15;
  const entry = sig.dir === 'long' ? sig.entry + cfg.entrySlipUsd : sig.entry - cfg.entrySlipUsd;
  const structural = sig.dir === 'long' ? entry - (sig.extreme - buffer) : sig.extreme + buffer - entry;
  // Never tighter than the minimum or 0.6 x the 15m ATR, so ordinary noise cannot stop the trade out.
  const dist = Math.max(structural, cfg.minStopUsd, 0.6 * sig.atr15);
  if (!(dist > 0)) return { ok: false, reason: 'no valid stop distance' };
  if (dist > cfg.maxStopUsd) return { ok: false, reason: `stop ${dist.toFixed(0)} USD wider than the ${cfg.maxStopUsd} limit` };
  const size = futuresLots({ riskUsd: cfg.riskUsd, stopDistance: dist, contractValue: cfg.contractValue, maxLots: cfg.maxLots });
  if (!size) return { ok: false, reason: `risk ${cfg.riskUsd} USD cannot buy even one lot at a ${dist.toFixed(0)} USD stop` };
  const lev = chooseLeverage(entry, dist, cfg.maxLeverage, cfg.liqFraction);
  if (lev == null) return { ok: false, reason: 'stop is too wide for the liquidation guard' };
  const fee = futuresFee({ price: entry, lots: size.lots, contractValue: cfg.contractValue, rate: cfg.takerRate }) * 2;
  if (!feeToRiskOk(fee, size.riskAtStopUsd, cfg.maxFeeToRisk)) {
    return { ok: false, reason: `round-trip fee ${fee.toFixed(2)} USD is over ${(cfg.maxFeeToRisk * 100).toFixed(0)}% of the ${size.riskAtStopUsd.toFixed(2)} USD risk` };
  }
  const sgn = sig.dir === 'long' ? 1 : -1;
  return {
    ok: true,
    plan: {
      dir: sig.dir, entry, stop: entry - sgn * dist, target: entry + sgn * cfg.targetR * dist, riskDist: dist,
      lots: size.lots, leverage: lev, riskAtStopUsd: size.riskAtStopUsd, roundTripFeeUsd: fee,
    },
  };
}

// ---------- exits ----------

export interface FuturesState {
  dir: Dir;
  entry: number;
  stop: number;
  target: number;
  riskDist: number;
  lots: number;
  openedAt: number;
  /** Best price reached in the trade's favour. */
  best: number;
  breakevenDone: boolean;
}

export type FuturesExit = { exit: false } | { exit: true; price: number; reason: 'stop' | 'target' | 'breakeven' | 'trail' | 'time'; maker: boolean };

/**
 * Process one bar for an open futures trade. The stop is tested against the stop in force BEFORE
 * this bar's own favourable move (conservative), and wins any same-bar tie with the target.
 * Mutates `st` (stop/best/breakeven) for the next bar.
 */
export function stepFutures(st: FuturesState, bar: Bar, cfgIn: Partial<FuturesConfig> = {}): FuturesExit {
  const cfg = { ...DEFAULT_FUTURES, ...cfgIn };
  const long = st.dir === 'long';
  const adverse = long ? bar.l : bar.h;
  const favour = long ? bar.h : bar.l;
  const hitStop = long ? adverse <= st.stop : adverse >= st.stop;
  if (hitStop) {
    const moved = st.breakevenDone;
    const slip = cfg.stopSlipUsd * (long ? -1 : 1);
    const reason = !moved ? 'stop' : (long ? st.stop > st.entry : st.stop < st.entry) ? 'trail' : 'breakeven';
    return { exit: true, price: st.stop + slip, reason, maker: false };
  }
  if (long ? favour >= st.target : favour <= st.target) return { exit: true, price: st.target, reason: 'target', maker: true };
  st.best = long ? Math.max(st.best, favour) : Math.min(st.best, favour);
  const gainR = (long ? st.best - st.entry : st.entry - st.best) / st.riskDist;
  if (!st.breakevenDone && gainR >= cfg.breakevenR) {
    st.stop = st.entry;
    st.breakevenDone = true;
  }
  if (gainR >= cfg.trailStartR) {
    const trail = long ? st.best - st.riskDist : st.best + st.riskDist;
    st.stop = long ? Math.max(st.stop, trail) : Math.min(st.stop, trail);
  }
  if (bar.t + 60_000 - st.openedAt >= cfg.maxHoldMin * 60_000) return { exit: true, price: bar.c, reason: 'time', maker: false };
  return { exit: false };
}

export interface FuturesPnl {
  gross: number;
  fees: number;
  net: number;
}

export function futuresPnl(dir: Dir, entry: number, exit: number, lots: number, entryFee: number, exitFee: number, contractValue = 0.001): FuturesPnl {
  const gross = (dir === 'long' ? exit - entry : entry - exit) * lots * contractValue;
  return { gross, fees: entryFee + exitFee, net: gross - entryFee - exitFee };
}
