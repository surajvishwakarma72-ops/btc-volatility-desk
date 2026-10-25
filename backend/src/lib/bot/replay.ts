import { bs, roundStrike, strike, yrs } from '../../backtest/lib/pricing.js';
import { CAL_ENTRY_MIN_IST, DEFAULT_CALENDAR, calendarBreakeven, isBackwardation, type CalendarConfig } from './calendar.js';
import { optionFee } from './costs.js';
import { portfolioMargin, type MarginPosition } from './portfolio-margin.js';
import { calendarExitConfig, computePnl, evaluateExit, exitConfigFor } from './rules.js';
import { DAY, MIN, SLOTS, istDateKey, istMidnightMs, runWindow } from './schedule.js';
import type { ExitConfig, Leg, PositionSnapshot, StrategyId } from './types.js';

/**
 * Historical replay of the bot's option strategies. It reuses the SAME exit rules, schedule, fee
 * model and portfolio-margin model as the live engine; only the market data differs: there are no
 * historical option quotes, so legs are repriced with Black-Scholes from spot and ATM IV (the same
 * approach as the existing backtest), with a synthetic bid/ask half-spread so fills are pessimistic.
 */
export interface ReplayBar {
  t: number;
  h: number;
  l: number;
  c: number;
}

export interface ReplayData {
  /** Bars with open time in [fromMs, toMs], chronological (1m or 15m). */
  barsBetween(fromMs: number, toMs: number): ReplayBar[];
  /** Implied vol in vol points for an expiry at time t, or null. */
  ivAt(expiryMs: number, t: number): number | null;
  /** DVOL at t (gate input), or null. */
  dvolAt(t: number): number | null;
  /** First/last bar time available. */
  first: number;
  last: number;
}

export type ReplayStrategy = StrategyId;

export interface ReplayConfig {
  lots: number;
  contractValue: number;
  /** Half the bid/ask spread as a fraction of the mark, with a floor in USD. */
  halfSpreadPct: number;
  halfSpreadMinUsd: number;
  feeRate: number;
  feePremiumCap: number;
  bodyDelta: number;
  /** DVOL at or above this makes the `gated` book skip. */
  gateDvolMax: number;
  /** Mark-to-market path resolution in minutes (stored for the exit grid). */
  pathStepMin: number;
  calendar: CalendarConfig;
}

export const DEFAULT_REPLAY: ReplayConfig = {
  lots: 100,
  contractValue: 0.001,
  halfSpreadPct: 0.012,
  halfSpreadMinUsd: 1,
  feeRate: 0.0001,
  feePremiumCap: 0.035,
  bodyDelta: 0.125,
  gateDvolMax: 65,
  pathStepMin: 15,
  calendar: DEFAULT_CALENDAR,
};

export interface ReplayRun {
  strategy: ReplayStrategy;
  book: 'always' | 'gated';
  dateKey: string;
  weekday: number;
  entryMs: number;
  exitMs: number;
  spotEntry: number;
  spotExit: number;
  entryIv: number;
  dvol: number | null;
  gateGo: boolean;
  marginUsd: number;
  feesUsd: number;
  grossPnl: number;
  netPnl: number;
  pctOfMargin: number;
  exitReason: string;
  peakPnl: number;
  troughPnl: number;
  /** Net PnL path: [minutes since entry, net PnL] every `pathStepMin`, ending at the exit. */
  path: Array<[number, number]>;
  legs: Array<{ type: 'call' | 'put'; side: 'long' | 'short'; role: Leg['role']; strike: number; entry: number; exit: number }>;
}

/** Daily option expiries settle at 12:00 UTC. */
export function expiriesAfter(t: number, count = 4): number[] {
  const out: number[] = [];
  let d = Math.floor(t / DAY) * DAY + 12 * 3_600_000;
  if (d <= t) d += DAY;
  for (let i = 0; i < count; i++) out.push(d + i * DAY);
  return out;
}

const grid = (spot: number) => (spot > 50_000 ? 500 : 250);

function nearestStrike(spot: number): number {
  const g = grid(spot);
  return Math.round(spot / g) * g;
}

type IvFn = (expiryMs: number, t: number) => number | null;

const mkLeg = (expiryMs: number, type: 'call' | 'put', side: 'long' | 'short', role: Leg['role'], K: number, lots: number): Leg => ({
  symbol: `${type === 'call' ? 'C' : 'P'}-${K}-${expiryMs}`,
  type,
  side,
  strike: K,
  expiryMs,
  lots,
  entryPrice: 0,
  role,
});

/** Strike selection mirrors the live engine: bodies on the N2N (3rd) expiry, straddles on the next. */
function planLegs(id: ReplayStrategy, spot: number, t: number, iv: IvFn, cfg: ReplayConfig): Leg[] | null {
  const ex = expiriesAfter(t);
  if (id === 'CAL_BACK') {
    const front = ex[0]!;
    const back = ex[2]!;
    const K = nearestStrike(spot);
    return [
      mkLeg(front, 'call', 'short', 'front', K, cfg.lots),
      mkLeg(front, 'put', 'short', 'front', K, cfg.lots),
      mkLeg(back, 'call', 'long', 'back', K, cfg.lots),
      mkLeg(back, 'put', 'long', 'back', K, cfg.lots),
    ];
  }
  const isLong = id === 'EVE_LONG' || id === 'PRE_LONG';
  const expiryMs = isLong ? ex[1]! : ex[2]!;
  if (isLong) {
    const K = nearestStrike(spot);
    return [mkLeg(expiryMs, 'call', 'long', 'body', K, cfg.lots), mkLeg(expiryMs, 'put', 'long', 'body', K, cfg.lots)];
  }
  const sigma = iv(expiryMs, t);
  if (sigma == null || !(sigma > 0)) return null;
  const T = yrs(expiryMs - t);
  const Kc = roundStrike(strike(spot, T, sigma, cfg.bodyDelta, 'c'), spot, 'c');
  const Kp = roundStrike(strike(spot, T, sigma, cfg.bodyDelta, 'p'), spot, 'p');
  return [mkLeg(expiryMs, 'call', 'short', 'body', Kc, cfg.lots), mkLeg(expiryMs, 'put', 'short', 'body', Kp, cfg.lots)];
}

const markOf = (leg: Leg, spot: number, t: number, iv: number): number =>
  Math.max(bs(spot, leg.strike, yrs(Math.max(leg.expiryMs - t, 1)), iv, leg.type === 'call' ? 'c' : 'p'), 0.05);

function halfSpread(mark: number, cfg: ReplayConfig): number {
  return Math.max(mark * cfg.halfSpreadPct, cfg.halfSpreadMinUsd);
}

function fee(price: number, spot: number, cfg: ReplayConfig): number {
  return optionFee({ price, lots: cfg.lots, contractValue: cfg.contractValue, spot, rate: cfg.feeRate, premiumCapRate: cfg.feePremiumCap });
}

function marginOf(legs: Leg[], spot: number, t: number, ivOf: (l: Leg) => number, cfg: ReplayConfig): number {
  const pos: MarginPosition[] = legs.map((l) => ({ type: l.type, side: l.side, strike: l.strike, expiryMs: l.expiryMs, lots: l.lots, iv: ivOf(l) }));
  return portfolioMargin(pos, spot, t, cfg.contractValue).margin;
}

export interface Window {
  entryAtMs: number;
  exitAtMs: number;
}

/** Entry/exit clock for any strategy. The calendar enters at 18:00 IST and must be out an hour before its front expiry. */
export function windowFor(id: ReplayStrategy, dateKey: string, cfg: ReplayConfig = DEFAULT_REPLAY): Window {
  if (id === 'CAL_BACK') {
    const entryAtMs = istMidnightMs(dateKey) + CAL_ENTRY_MIN_IST * MIN;
    const front = expiriesAfter(entryAtMs)[0]!;
    return { entryAtMs, exitAtMs: front - cfg.calendar.hardCloseBeforeMs };
  }
  return runWindow(id, dateKey);
}

/** How often the replay re-checks the entry conditions inside a wait window (the live bot checks every minute). */
const REPLAY_RETRY_MIN = 5;

/**
 * Simulate one strategy on one IST date. Returns null when data, strikes or the entry condition are unavailable.
 * Strategies with a wait window (the short strangles) retry the entry through the window and take the first
 * time it passes, exactly like the live engine; the exit clock does not move.
 */
export function replayRun(
  data: ReplayData,
  id: ReplayStrategy,
  dateKey: string,
  book: 'always' | 'gated',
  cfg: ReplayConfig = DEFAULT_REPLAY,
): ReplayRun | null {
  const w = windowFor(id, dateKey, cfg);
  const wait = id === 'CAL_BACK' ? 0 : SLOTS[id].waitMin;
  for (let off = 0; off <= Math.max(wait - 1, 0); off += REPLAY_RETRY_MIN) {
    const r = replayAt(data, id, dateKey, book, cfg, w.exitAtMs, w.entryAtMs + off * MIN);
    if (r) return r;
  }
  return null;
}

function replayAt(
  data: ReplayData,
  id: ReplayStrategy,
  dateKey: string,
  book: 'always' | 'gated',
  cfg: ReplayConfig,
  exitAtMs: number,
  entryAtMs: number,
): ReplayRun | null {
  const w: Window = { entryAtMs, exitAtMs };
  const head = data.barsBetween(entryAtMs - 15 * MIN, entryAtMs + 15 * MIN);
  const entryBar = head.find((b) => b.t >= entryAtMs - MIN) ?? null;
  // a retried entry must use a bar from its own moment (within the retry step); only the calendar, which does not retry, keeps the wider 15 minutes
  const tol = id === 'CAL_BACK' ? 15 * MIN : REPLAY_RETRY_MIN * MIN;
  if (!entryBar || entryBar.t > entryAtMs + tol) return null;
  const t0 = entryAtMs;
  const spot0 = entryBar.c;

  const dvol = data.dvolAt(t0);
  const gateGo = dvol != null && dvol < cfg.gateDvolMax;
  if (book === 'gated' && !gateGo) return null;

  const ivNow: IvFn = (exp, t) => data.ivAt(exp, t) ?? data.dvolAt(t);
  const planned = planLegs(id, spot0, t0, ivNow, cfg);
  if (!planned) return null;
  const bars = data.barsBetween(entryAtMs - 15 * MIN, exitAtMs + 5 * MIN);
  if (!bars.length) return null;

  // Each leg is repriced with the IV of its own expiry (matters for the calendar).
  const iv0 = new Map<number, number>();
  for (const l of planned) {
    const v = ivNow(l.expiryMs, t0);
    if (v == null || !(v > 0)) return null;
    iv0.set(l.expiryMs, v);
  }
  const ivOfAt = (l: Leg, t: number) => ivNow(l.expiryMs, t) ?? iv0.get(l.expiryMs)!;
  const entryIv = iv0.get(planned[0]!.expiryMs)!;

  let exitCfg: ExitConfig;
  if (id === 'CAL_BACK') {
    const front = planned[0]!;
    const back = planned[2]!;
    const fIv = iv0.get(front.expiryMs)!;
    const bIv = iv0.get(back.expiryMs)!;
    if (!isBackwardation(fIv, bIv, cfg.calendar.minBackwardation)) return null;
  }

  // Entry fills: sell at mark minus half-spread, buy at mark plus half-spread.
  let feesEntry = 0;
  const legs: Leg[] = planned.map((l) => {
    const m = markOf(l, spot0, t0, iv0.get(l.expiryMs)!);
    const px = l.side === 'short' ? Math.max(m - halfSpread(m, cfg), 0.05) : m + halfSpread(m, cfg);
    feesEntry += fee(px, spot0, cfg);
    return { ...l, entryPrice: px };
  });
  const marginUsd = marginOf(legs, spot0, t0, (l) => iv0.get(l.expiryMs)!, cfg);

  if (id === 'CAL_BACK') {
    const front = legs[0]!;
    const back = legs[2]!;
    const netDebit = legs.filter((l) => l.side === 'long').reduce((s, l) => s + l.entryPrice, 0) - legs.filter((l) => l.side === 'short').reduce((s, l) => s + l.entryPrice, 0);
    const be = calendarBreakeven(
      { strike: front.strike, frontExpiryMs: front.expiryMs, backExpiryMs: back.expiryMs, frontIv: iv0.get(front.expiryMs)!, backIv: iv0.get(back.expiryMs)! },
      netDebit,
    );
    // The breakeven is per BTC and for both legs; a profit zone must exist or there is nothing to trade.
    if (!be) return null;
    exitCfg = calendarExitConfig({ low: be.low, high: be.high }, front.expiryMs);
  } else {
    exitCfg = exitConfigFor(id, w.exitAtMs);
  }
  const stopOnly: ExitConfig = exitCfg.stopMultiple != null ? { stopMultiple: exitCfg.stopMultiple } : {};

  const path: Array<[number, number]> = [[0, -feesEntry]];
  let peak = -feesEntry;
  let trough = -feesEntry;
  let lastPathAt = t0;
  let exitMs = w.exitAtMs;
  let reason = 'time';
  let spotExit = spot0;
  let exitMarks: number[] | null = null;

  for (const b of bars) {
    if (b.t < t0 + MIN) continue;
    if (b.t > w.exitAtMs) break;
    const t = b.t;
    const closeMarks = legs.map((l) => ({ symbol: l.symbol, mark: markOf(l, b.c, t, ivOfAt(l, t)) }));
    const snapClose: PositionSnapshot = { legs, marks: closeMarks, spot: b.c, marginUsd, contractValue: cfg.contractValue, feesPaidUsd: feesEntry };

    // Intrabar worst case for the stop: shorts at their adverse extreme (calls at the high, puts at the low).
    if (stopOnly.stopMultiple != null) {
      const worst = legs.map((l) => ({ symbol: l.symbol, mark: markOf(l, l.type === 'call' ? b.h : b.l, t, ivOfAt(l, t)) }));
      const d = evaluateExit({ ...snapClose, marks: worst }, stopOnly, t);
      if (d.action === 'exit') {
        reason = 'stop';
        exitMs = t;
        spotExit = b.c;
        // Stopped legs fill at the stop level, the rest at the bar close.
        exitMarks = legs.map((l, i) => {
          if (l.side === 'short' && l.role === 'body' && worst[i]!.mark >= l.entryPrice * stopOnly.stopMultiple!) {
            return Math.max(l.entryPrice * stopOnly.stopMultiple!, closeMarks[i]!.mark);
          }
          return closeMarks[i]!.mark;
        });
        break;
      }
    }

    const pnl = computePnl(snapClose);
    peak = Math.max(peak, pnl.netPnl);
    trough = Math.min(trough, pnl.netPnl);
    if (t - lastPathAt >= cfg.pathStepMin * MIN) {
      path.push([Math.round((t - t0) / MIN), pnl.netPnl]);
      lastPathAt = t;
    }
    const d = evaluateExit(snapClose, exitCfg, t);
    if (d.action === 'exit') {
      reason = d.reason;
      exitMs = t;
      spotExit = b.c;
      exitMarks = closeMarks.map((m) => m.mark);
      break;
    }
    spotExit = b.c;
    exitMs = t;
    exitMarks = closeMarks.map((m) => m.mark);
  }
  if (!exitMarks) return null;

  // Exit fills with the same pessimistic spread and fees.
  let feesExit = 0;
  const exits = legs.map((l, i) => {
    const m = exitMarks![i]!;
    const buying = l.side === 'short';
    const px = buying ? m + halfSpread(m, cfg) : Math.max(m - halfSpread(m, cfg), 0.05);
    feesExit += fee(px, spotExit, cfg);
    return px;
  });
  const gross = legs.reduce((s, l, i) => s + (l.side === 'short' ? l.entryPrice - exits[i]! : exits[i]! - l.entryPrice) * l.lots * cfg.contractValue, 0);
  const net = gross - feesEntry - feesExit;
  path.push([Math.round((exitMs - t0) / MIN), net]);
  peak = Math.max(peak, net);
  trough = Math.min(trough, net);

  return {
    strategy: id,
    book,
    dateKey,
    weekday: new Date(istMidnightMs(dateKey) + 19_800_000).getUTCDay(),
    entryMs: t0,
    exitMs,
    spotEntry: spot0,
    spotExit,
    entryIv,
    dvol,
    gateGo,
    marginUsd,
    feesUsd: feesEntry + feesExit,
    grossPnl: gross,
    netPnl: net,
    pctOfMargin: marginUsd > 0 ? net / marginUsd : 0,
    exitReason: reason,
    peakPnl: peak,
    troughPnl: trough,
    path,
    legs: legs.map((l, i) => ({ type: l.type, side: l.side, role: l.role, strike: l.strike, entry: l.entryPrice, exit: exits[i]! })),
  };
}

export interface ReplayOptions {
  strategies?: ReplayStrategy[];
  fromDate?: string;
  toDate?: string;
  cfg?: Partial<ReplayConfig>;
}

export function replayAll(data: ReplayData, opts: ReplayOptions = {}): { runs: ReplayRun[]; skipped: number; days: number } {
  const cfg = { ...DEFAULT_REPLAY, ...opts.cfg };
  const ids = opts.strategies ?? [...(Object.keys(SLOTS) as ReplayStrategy[]), 'CAL_BACK'];
  const from = opts.fromDate ?? istDateKey(data.first + DAY);
  const to = opts.toDate ?? istDateKey(data.last - 2 * DAY);
  const runs: ReplayRun[] = [];
  let skipped = 0;
  let days = 0;
  for (let ms = istMidnightMs(from); ms <= istMidnightMs(to); ms += DAY) {
    const dateKey = istDateKey(ms + 12 * 3_600_000);
    days++;
    for (const id of ids) {
      const books: Array<'always' | 'gated'> = id === 'EVE_LONG' || id === 'PRE_LONG' || id === 'CAL_BACK' ? ['always'] : ['always', 'gated'];
      for (const book of books) {
        const r = replayRun(data, id, dateKey, book, cfg);
        if (r) runs.push(r);
        else if (book === 'always') skipped++;
      }
    }
  }
  return { runs, skipped, days };
}
