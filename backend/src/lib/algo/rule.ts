import { z } from 'zod';
import { IST_OFFSET_MS, istDateKey, istMidnightMs } from '../bot/schedule.js';

/**
 * The Algo panel's rule model. Nothing here is fixed: every choice (instrument, strikes, expiry, conditions, times,
 * days, stops and targets) is data the user writes, validated here and evaluated by pure functions so it can be tested.
 */
export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayName = (typeof DAY_NAMES)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must look like 22:30');
const tf = z.enum(['5m', '15m', '1h']);
const cmp = z.enum(['<', '>']);

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gate') }),
  z.object({ type: z.literal('dvol'), op: cmp, value: z.number().min(0).max(500) }),
  z.object({ type: z.literal('spot'), op: cmp, value: z.number().positive() }),
  z.object({ type: z.literal('premium'), value: z.number().min(0) }),
  z.object({ type: z.literal('rsi'), tf, op: cmp, value: z.number().min(0).max(100), period: z.number().int().min(2).max(100).optional() }),
  z.object({ type: z.literal('adx'), tf, op: cmp, value: z.number().min(0).max(100), period: z.number().int().min(2).max(100).optional() }),
  z.object({ type: z.literal('ema'), tf, fast: z.number().int().min(2).max(200), slow: z.number().int().min(3).max(400), state: z.enum(['above', 'below']) }),
  /** ATM implied volatility of the chosen expiry, in vol points. */
  z.object({ type: z.literal('atmiv'), op: cmp, value: z.number().min(0).max(500) }),
  /** Speed vs IV: how far price moved over `minutes`, in units of the move the ATM IV implies for that time. 1 = exactly as implied. */
  z.object({ type: z.literal('speed'), op: cmp, value: z.number().min(0).max(50), minutes: z.number().int().min(5).max(720).optional() }),
  z.object({ type: z.literal('macd'), tf, state: z.enum(['bullish', 'bearish']) }),
  z.object({ type: z.literal('bb'), tf, state: z.enum(['above_upper', 'below_lower', 'inside']), period: z.number().int().min(5).max(100).optional() }),
  z.object({ type: z.literal('atr'), tf, op: cmp, pct: z.number().min(0).max(50), period: z.number().int().min(2).max(100).optional() }),
  z.object({ type: z.literal('vwap'), state: z.enum(['above', 'below']) }),
  z.object({ type: z.literal('change'), op: cmp, pct: z.number().min(-50).max(50), minutes: z.number().int().min(5).max(1440) }),
  /** ADX is below `value` and lower than it was `bars` bars ago: a trend that is fading. */
  z.object({ type: z.literal('adx_falling'), tf, value: z.number().min(0).max(100), bars: z.number().int().min(1).max(50).optional() }),
  /** ATM IV / DVOL is lower than it was `minutes` ago by at least `minDrop` vol points. */
  z.object({ type: z.literal('atmiv_falling'), minutes: z.number().int().min(5).max(720), minDrop: z.number().min(0).max(50).optional() }),
  z.object({ type: z.literal('dvol_falling'), minutes: z.number().int().min(5).max(720), minDrop: z.number().min(0).max(50).optional() }),
  /** RSI is lower than it was `bars` bars ago by at least `minDrop` points. */
  z.object({ type: z.literal('rsi_falling'), tf, bars: z.number().int().min(1).max(50).optional(), minDrop: z.number().min(0).max(50).optional() }),
  /** Realised volatility over the last `minutes` is lower than over the `minutes` before. */
  z.object({ type: z.literal('rv_falling'), minutes: z.number().int().min(15).max(720).optional() }),
  /** Tonight IV against what the IV usually is at this clock time: `above` (rich) or `below` (cheap) by at least `points`. */
  z.object({ type: z.literal('ivclock'), op: z.enum(['above', 'below']), points: z.number().min(0).max(50) }),
  /** Edge: ATM IV minus expected realised vol, in vol points, between `low` and `high`. */
  z.object({ type: z.literal('edge'), low: z.number().min(-100).max(100), high: z.number().min(-100).max(100) }),
]);
export type Condition = z.infer<typeof conditionSchema>;

/** How a leg's strike is chosen. A delta band picks the lowest delta inside it ("whichever is lower"). */
export const pickSchema = z.discriminatedUnion('mode', [
  /** `target`: the strike whose delta is NEAREST to it. `low`/`high` (older rules): the lowest delta inside the band. */
  z.object({ mode: z.literal('delta'), target: z.number().min(0.01).max(0.9).optional(), low: z.number().min(0.01).max(0.9).optional(), high: z.number().min(0.01).max(0.9).optional() }),
  z.object({ mode: z.literal('strike'), strike: z.number().positive() }),
  z.object({ mode: z.literal('offset'), points: z.number().min(0).max(200_000) }),
  z.object({ mode: z.literal('atm') }),
]);
export type LegPick = z.infer<typeof pickSchema>;

export const optionLegSchema = z.object({
  type: z.enum(['call', 'put']),
  side: z.enum(['sell', 'buy']),
  pick: pickSchema,
  /** Lots for this leg; left out, the lots of the entry command are used. */
  lots: z.number().int().min(1).max(1_000_000).optional(),
});
export type OptionLegRule = z.infer<typeof optionLegSchema>;

/**
 * current = 0DTE (the first expiry still listed), next = 1DTE, n2n = 2DTE, fixed = an expiry code like 261027.
 * `nearest` and `b2b` are older saved rules: nearest is current, b2b trades the first two together.
 */
export const expirySchema = z.object({
  mode: z.enum(['current', 'next', 'n2n', 'fixed', 'nearest', 'b2b']),
  code: z.string().regex(/^\d{6}$/).optional(),
});
export type ExpiryRule = z.infer<typeof expirySchema>;

export const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hard'), time: hhmm }),
  z.object({ kind: z.literal('window'), from: hhmm, to: hhmm, conditions: z.array(conditionSchema).max(12) }),
]);
export type EntryRule = z.infer<typeof entrySchema>;

export const exitSchema = z.object({
  /** Per-leg stop as a multiple of the sell price (2 = double). null: no per-leg stop. */
  legStopMultiple: z.number().min(1.05).max(20).nullable(),
  /** Futures: stop and target in dollars of profit or loss on the position (the price level is worked out from the lots). */
  futStopUsd: z.number().positive().nullable().optional(),
  futTargetUsd: z.number().positive().nullable().optional(),
  /** Futures, older rules: stop and target as a percent of the entry price. */
  futStopPct: z.number().min(0.1).max(50).nullable().optional(),
  futTargetPct: z.number().min(0.1).max(200).nullable().optional(),
  netTargetUsd: z.number().positive().nullable(),
  netStopUsd: z.number().positive().nullable(),
  /** Close everything at this IST time (the first one after the entry). */
  exitTime: hhmm.nullable(),
  /** Alarm this many points before a leg's stop, hard exit this many points before it. */
  alarmPoints: z.number().min(1).max(10_000),
  hardPoints: z.number().min(0).max(10_000),
  exitAllOnLegStop: z.boolean(),
});
export type ExitRule = z.infer<typeof exitSchema>;

export const futureLegSchema = z.object({ side: z.enum(['long', 'short']), lots: z.number().int().min(1).max(1_000_000).optional() });

export const strategySchema = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(['paper', 'live']),
  instrument: z.enum(['option', 'future']),
  legs: z.array(optionLegSchema).max(8),
  future: futureLegSchema.optional(),
  expiry: expirySchema,
  entry: entrySchema,
  days: z.array(z.enum(DAY_NAMES)).min(1).max(7),
  exit: exitSchema,
}).superRefine((s, ctx) => {
  if (s.instrument === 'option' && s.legs.length === 0) ctx.addIssue({ code: 'custom', path: ['legs'], message: 'an option strategy needs at least one leg' });
  if (s.instrument === 'future' && !s.future) ctx.addIssue({ code: 'custom', path: ['future'], message: 'a futures strategy needs a long or short side' });
  if (s.expiry.mode === 'fixed' && !s.expiry.code) ctx.addIssue({ code: 'custom', path: ['expiry', 'code'], message: 'a fixed expiry needs its code, like 261027' });
  for (const [i, l] of s.legs.entries()) {
    if (l.pick.mode === 'delta' && l.pick.target == null && (l.pick.low == null || l.pick.high == null)) ctx.addIssue({ code: 'custom', path: ['legs', i, 'pick'], message: 'give the delta to aim for' });
    if (l.pick.mode === 'delta' && l.pick.low != null && l.pick.high != null && l.pick.low > l.pick.high) ctx.addIssue({ code: 'custom', path: ['legs', i, 'pick'], message: 'delta low must not be above high' });
  }
  for (const [i, c] of (s.entry.kind === 'window' ? s.entry.conditions : []).entries()) {
    if (c.type === 'edge' && c.low > c.high) ctx.addIssue({ code: 'custom', path: ['entry', 'conditions', i], message: 'edge: low must not be above high' });
    if (c.type === 'ema' && c.fast >= c.slow) ctx.addIssue({ code: 'custom', path: ['entry', 'conditions', i], message: 'the fast EMA must be shorter than the slow one' });
  }
});
export type AlgoStrategy = z.infer<typeof strategySchema>;

export const DEFAULT_EXIT: ExitRule = {
  legStopMultiple: 2, futStopPct: null, futTargetPct: null, netTargetUsd: null, netStopUsd: null, exitTime: null,
  alarmPoints: 20, hardPoints: 5, exitAllOnLegStop: true,
};

/** The saved defaults behind "entry 50": ONE short strangle (2 legs) at the strikes nearest 0.10 delta, current (0DTE) expiry, 2x stops. */
export function defaultStrangle(over: Partial<AlgoStrategy> = {}): AlgoStrategy {
  return {
    name: 'Short strangle', mode: 'paper', instrument: 'option',
    legs: [
      { type: 'call', side: 'sell', pick: { mode: 'delta', target: 0.1 } },
      { type: 'put', side: 'sell', pick: { mode: 'delta', target: 0.1 } },
    ],
    expiry: { mode: 'current' },
    entry: { kind: 'hard', time: '22:30' },
    days: [...DAY_NAMES],
    exit: { ...DEFAULT_EXIT },
    ...over,
  };
}

// ---------- clock (all IST) ----------

export const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Day of week in IST of an instant. */
export const istDay = (ms: number): DayName => DAY_NAMES[new Date(ms + IST_OFFSET_MS).getUTCDay()]!;

export interface EntryWindow {
  dateKey: string;
  startMs: number;
  endMs: number;
}

/** The window that begins on one IST date: a hard time is a window of one minute; a window may run past midnight. */
export function windowOn(entry: EntryRule, dateKey: string): EntryWindow {
  const mid = istMidnightMs(dateKey);
  if (entry.kind === 'hard') {
    const s = mid + minutesOf(entry.time) * 60_000;
    return { dateKey, startMs: s, endMs: s + 60_000 };
  }
  const from = minutesOf(entry.from);
  let to = minutesOf(entry.to);
  if (to <= from) to += 1440;
  return { dateKey, startMs: mid + from * 60_000, endMs: mid + to * 60_000 };
}

export type EntryState =
  | { state: 'open'; window: EntryWindow }
  | { state: 'before'; window: EntryWindow }
  | { state: 'closed' };

/**
 * Where the entry stands right now. A window that started yesterday and runs past midnight is still open after midnight;
 * the day selection is judged on the day the window STARTS (a Friday 22:30 window that runs to 01:30 is a Friday trade).
 */
export function entryState(s: Pick<AlgoStrategy, 'entry' | 'days'>, nowMs: number): EntryState {
  const today = istDateKey(nowMs);
  const yesterday = istDateKey(nowMs - 86_400_000);
  for (const key of [today, yesterday]) {
    const w = windowOn(s.entry, key);
    const day = istDay(w.startMs);
    if (s.days.includes(day) && nowMs >= w.startMs && nowMs < w.endMs) return { state: 'open', window: w };
  }
  const w = windowOn(s.entry, today);
  if (s.days.includes(istDay(w.startMs)) && nowMs < w.startMs) return { state: 'before', window: w };
  return { state: 'closed' };
}

/** When to close everything: the first exit time after the window starts, or null for no time exit. */
export function exitAtMs(exit: ExitRule, window: EntryWindow, enteredAtMs: number): number | null {
  if (!exit.exitTime) return null;
  const startMin = Math.floor(((window.startMs - IST_OFFSET_MS) % 86_400_000 + 86_400_000) % 86_400_000 / 60_000);
  let m = minutesOf(exit.exitTime);
  if (m <= startMin) m += 1440;
  let at = istMidnightMs(window.dateKey) + m * 60_000;
  while (at <= enteredAtMs) at += 86_400_000;
  return at;
}
