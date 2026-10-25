import type { RunRecord } from './analytics.js';
import { futuresFee } from './costs.js';
import {
  DEFAULT_FUTURES, detectSessionSweep, detectSignal, planTrade, stepFutures, futuresPnl,
  type Bar, type FuturesConfig, type FuturesSignal, type FuturesState, type FuturesStrategy,
} from './futures.js';
import { DAY, MIN, istDateKey, istMidnightMs } from './schedule.js';
import { istDay, sessionBounds } from './sessions.js';

/**
 * Historical replay of the futures strategies over 1m candles. Uses exactly the detectors, trade
 * plan and exit stepping the live paper engine uses. Funding, open interest, liquidation and CVD
 * crowding cannot be replayed (that history is not archived), so replay tests only the price
 * confirmations; the live engine adds the positioning ones on top.
 */
export interface FuturesReplayRun extends RunRecord {
  dir: 'long' | 'short';
  lots: number;
  leverage: number;
  entry: number;
  exit: number;
  stop: number;
  target: number;
  note: string;
  confirmations: string[];
  grossPnl: number;
}

const STRATEGIES: FuturesStrategy[] = ['FUT_SWEEP_LDN', 'FUT_SWEEP_NY', 'FUT_SIGNAL'];
const WINDOW_BARS = 1500;

interface Open {
  st: FuturesState;
  sig: FuturesSignal;
  lots: number;
  leverage: number;
  entryFee: number;
  entryMs: number;
  stop0: number;
  target0: number;
  path: Array<[number, number]>;
  lastPathAt: number;
  peak: number;
  trough: number;
}

function inSweepWindow(strategy: FuturesStrategy, nowMs: number, cfg: FuturesConfig): boolean {
  if (strategy === 'FUT_SIGNAL') return true;
  const attack = strategy === 'FUT_SWEEP_LDN' ? 'LONDON' : 'NEW YORK';
  const d = istDay(nowMs);
  for (const day of [d, d - 1]) {
    const b = sessionBounds(attack, day);
    if (nowMs >= b.start && nowMs < Math.min(b.start + cfg.sweepWindowMin * MIN, b.end)) return true;
  }
  return false;
}

export function replayFutures(
  bars: readonly Bar[],
  opts: { strategies?: FuturesStrategy[]; cfg?: Partial<FuturesConfig>; fromMs?: number; toMs?: number } = {},
): { runs: FuturesReplayRun[]; skippedByPlan: Record<string, number>; signals: number } {
  const cfg: FuturesConfig = { ...DEFAULT_FUTURES, ...opts.cfg };
  const strategies = opts.strategies ?? STRATEGIES;
  const runs: FuturesReplayRun[] = [];
  const skippedByPlan: Record<string, number> = {};
  const open = new Map<FuturesStrategy, Open>();
  const tradedSession = new Set<string>();
  const lastSignalAt = new Map<FuturesStrategy, number>();
  const perDay = new Map<string, number>();
  let signals = 0;

  // Prior IST-day ranges for FUT_SIGNAL, built once.
  const dayRange = new Map<string, { high: number; low: number }>();
  for (const b of bars) {
    const k = istDateKey(b.t);
    const r = dayRange.get(k);
    if (!r) dayRange.set(k, { high: b.h, low: b.l });
    else {
      r.high = Math.max(r.high, b.h);
      r.low = Math.min(r.low, b.l);
    }
  }

  const close = (id: FuturesStrategy, o: Open, price: number, reason: string, maker: boolean, atMs: number) => {
    const exitFee = futuresFee({ price, lots: o.lots, contractValue: cfg.contractValue, rate: maker ? cfg.makerRate : cfg.takerRate });
    const p = futuresPnl(o.st.dir, o.st.entry, price, o.lots, o.entryFee, exitFee, cfg.contractValue);
    o.path.push([Math.round((atMs - o.entryMs) / MIN), p.net]);
    o.peak = Math.max(o.peak, p.net);
    o.trough = Math.min(o.trough, p.net);
    const dateKey = istDateKey(o.entryMs);
    runs.push({
      strategy: id, book: 'always', dateKey, weekday: new Date(istMidnightMs(dateKey) + 19_800_000).getUTCDay(),
      entryMs: o.entryMs, exitMs: atMs, entryIv: null, dvol: null, gateGo: null,
      marginUsd: (o.st.entry * o.lots * cfg.contractValue) / o.leverage, feesUsd: p.fees, netPnl: p.net, exitReason: reason,
      peakPnl: o.peak, troughPnl: o.trough, path: o.path,
      dir: o.st.dir, lots: o.lots, leverage: o.leverage, entry: o.st.entry, exit: price, stop: o.stop0, target: o.target0,
      note: o.sig.note, confirmations: o.sig.confirmations.filter((c) => c.ok).map((c) => c.name), grossPnl: p.gross,
    });
    open.delete(id);
  };

  const from = opts.fromMs ?? bars[0]?.t ?? 0;
  const to = opts.toMs ?? bars[bars.length - 1]?.t ?? 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.t < from || b.t > to) continue;

    // 1) Manage open trades on this bar (entries happen at bar close, so management starts next bar).
    for (const [id, o] of [...open.entries()]) {
      if (b.t < o.entryMs) continue;
      const ex = stepFutures(o.st, b, cfg);
      const mtm = futuresPnl(o.st.dir, o.st.entry, b.c, o.lots, o.entryFee, 0, cfg.contractValue).net;
      o.peak = Math.max(o.peak, mtm);
      o.trough = Math.min(o.trough, mtm);
      if (ex.exit) close(id, o, ex.price, ex.reason, ex.maker, b.t + MIN);
      else if (b.t - o.lastPathAt >= 15 * MIN) {
        o.path.push([Math.round((b.t - o.entryMs) / MIN), mtm]);
        o.lastPathAt = b.t;
      }
    }

    // 2) Look for entries once a 5m bar has closed.
    const closeMs = b.t + MIN;
    if (closeMs % (5 * MIN) !== 0) continue;
    const win = bars.slice(Math.max(0, i + 1 - WINDOW_BARS), i + 1);
    if (win.length < 400) continue;
    for (const id of strategies) {
      if (open.has(id) || !inSweepWindow(id, closeMs, cfg)) continue;
      let sig: FuturesSignal | null = null;
      if (id === 'FUT_SIGNAL') {
        const last = lastSignalAt.get(id) ?? 0;
        const dk = istDateKey(closeMs);
        if (closeMs - last < cfg.signalCooldownMin * MIN || (perDay.get(dk) ?? 0) >= cfg.signalMaxPerDay) continue;
        const prev = dayRange.get(istDateKey(closeMs - DAY));
        sig = detectSignal({ bars1m: win, nowMs: closeMs, cfg, prevDay: prev ? { ...prev, from: 0, to: 0 } : null });
      } else {
        // One sweep trade per attacking session: the 4h window never crosses an IST midnight.
        if (tradedSession.has(`${id}|${istDay(closeMs - 1)}`)) continue;
        sig = detectSessionSweep(id, { bars1m: win, nowMs: closeMs, cfg });
      }
      if (!sig) continue;
      signals++;
      const plan = planTrade(sig, cfg);
      if (!plan.ok) {
        skippedByPlan[plan.reason.replace(/[0-9.]+/g, '#')] = (skippedByPlan[plan.reason.replace(/[0-9.]+/g, '#')] ?? 0) + 1;
        continue;
      }
      const p = plan.plan;
      const entryFee = futuresFee({ price: p.entry, lots: p.lots, contractValue: cfg.contractValue, rate: cfg.takerRate });
      lastSignalAt.set(id, closeMs);
      if (id !== 'FUT_SIGNAL') tradedSession.add(`${id}|${istDay(closeMs - 1)}`);
      const dk = istDateKey(closeMs);
      perDay.set(dk, (perDay.get(dk) ?? 0) + 1);
      open.set(id, {
        st: { dir: p.dir, entry: p.entry, stop: p.stop, target: p.target, riskDist: p.riskDist, lots: p.lots, openedAt: closeMs, best: p.entry, breakevenDone: false },
        sig, lots: p.lots, leverage: p.leverage, entryFee, entryMs: closeMs, stop0: p.stop, target0: p.target,
        path: [[0, -entryFee]], lastPathAt: closeMs, peak: -entryFee, trough: -entryFee,
      });
    }
  }

  // Any trade still open at the end of the data is closed at the last close.
  const last = bars[bars.length - 1];
  if (last) for (const [id, o] of [...open.entries()]) close(id, o, last.c, 'time', false, last.t + MIN);
  return { runs, skippedByPlan, signals };
}

