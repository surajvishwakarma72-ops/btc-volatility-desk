import { futuresFee, walkBook } from '../../lib/bot/costs.js';
import {
  DEFAULT_FUTURES, detectSessionSweep, detectSignal, futuresPnl, planTrade, stepFutures,
  type Bar, type FuturesConfig, type FuturesSignal, type FuturesState, type FuturesStrategy,
} from '../../lib/bot/futures.js';
import type { GuardResult } from '../../lib/bot/risk-guard.js';
import { MIN, istDateKey, istMidnightMs } from '../../lib/bot/schedule.js';
import {
  closeRun, countRunsSince, insertFill, insertLeg, insertRun, lastEntryMs, logEvent, runKeyExists, setLegExit, updateExitConfig,
  updatePeaks, upsertMark,
} from './bot-store.js';
import { DEFAULT_PERP, fetchBook, fetchCandles, fetchPerpInfo, type PerpInfo } from './delta-public.js';

/**
 * Bars the detectors see (~25h). A longer buffer (~50h, under Delta's 4000-candle cap) is kept so
 * yesterday's full IST-day range is available to FUT_SIGNAL.
 */
const WINDOW_BARS = 1500;
const BUFFER_BARS = 3000;
const STRATEGIES: FuturesStrategy[] = ['FUT_SWEEP_LDN', 'FUT_SWEEP_NY', 'FUT_SIGNAL'];

interface PersistedFutures {
  kind: 'futures';
  st: FuturesState;
  leverage: number;
  stop0: number;
  target0: number;
  lastBarT: number;
  entryFee: number;
  note: string;
  confirmations: string[];
}

export interface FuturesRun {
  id: string;
  key: string;
  strategy: FuturesStrategy;
  st: FuturesState;
  leverage: number;
  stop0: number;
  target0: number;
  lastBarT: number;
  entryFee: number;
  marginUsd: number;
  note: string;
  confirmations: string[];
  entryMs: number;
  closing: boolean;
}

export interface FuturesHooks {
  riskCheck(marginUsd: number, now: number): Promise<GuardResult>;
  mode: string;
}

/**
 * Paper futures engine: 1m candles from Delta, the same detectors / plan / exit stepping as the
 * replay, fills walked through the perpetual's real order book, real fee rates. Exits are decided on
 * closed 1m bars (up to a minute of lag, which is acceptable for paper trading).
 */
export class FuturesLive {
  open = new Map<string, FuturesRun>();
  private bars: Bar[] = [];
  private perp: PerpInfo = DEFAULT_PERP;
  private perpAt = 0;
  private lastDetect = 0;
  cfg: FuturesConfig = { ...DEFAULT_FUTURES, ...(process.env.BOT_FUT_RISK_USD ? { riskUsd: Number(process.env.BOT_FUT_RISK_USD) } : {}) };

  constructor(private hooks: FuturesHooks) {}

  get enabled(): boolean {
    return process.env.BOT_FUTURES !== 'false';
  }

  summary(): { margin: number; positions: number } {
    return { margin: [...this.open.values()].reduce((s, r) => s + r.marginUsd, 0), positions: this.open.size };
  }

  static isFuturesConfig(exitConfig: unknown): boolean {
    return !!exitConfig && typeof exitConfig === 'object' && (exitConfig as { kind?: string }).kind === 'futures';
  }

  restore(rows: Array<{ id: string; run_key: string; strategy: string; margin_usd: string | null; entry_at: Date | null; exit_config: unknown }>): void {
    for (const r of rows) {
      const p = r.exit_config as PersistedFutures | null;
      if (!p || p.kind !== 'futures') continue;
      this.open.set(r.id, {
        id: r.id, key: r.run_key, strategy: r.strategy as FuturesStrategy, st: p.st, leverage: p.leverage, stop0: p.stop0, target0: p.target0,
        lastBarT: p.lastBarT, entryFee: p.entryFee, marginUsd: Number(r.margin_usd ?? 0), note: p.note, confirmations: p.confirmations,
        entryMs: r.entry_at ? new Date(r.entry_at).getTime() : p.st.openedAt, closing: false,
      });
    }
  }

  /** Last close price, for marking open positions. */
  lastPrice(): number | null {
    return this.bars.length ? this.bars[this.bars.length - 1]!.c : null;
  }

  private async refresh(now: number): Promise<void> {
    const endSec = Math.floor(now / 1000);
    if (!this.bars.length) {
      this.bars = await fetchCandles('BTCUSD', '1m', endSec - BUFFER_BARS * 60, endSec);
    } else {
      const fresh = await fetchCandles('BTCUSD', '1m', endSec - 15 * 60, endSec);
      const byT = new Map(this.bars.map((b) => [b.t, b]));
      for (const b of fresh) byT.set(b.t, b);
      this.bars = [...byT.values()].sort((a, b) => a.t - b.t).slice(-(BUFFER_BARS + 60));
    }
  }

  /** Bars whose minute has fully closed. */
  private closed(now: number): Bar[] {
    return this.bars.filter((b) => b.t + MIN <= now);
  }

  async tick(now: number, opts: { allowEntries: boolean }): Promise<void> {
    if (!this.enabled) return;
    if (now - this.perpAt > 30 * MIN) {
      this.perp = await fetchPerpInfo();
      this.perpAt = now;
    }
    await this.refresh(now);
    const bars = this.closed(now);
    const last = bars[bars.length - 1];
    if (!last) return;

    for (const run of [...this.open.values()]) await this.manage(run, bars);

    const closeMs = last.t + MIN;
    if (!opts.allowEntries || closeMs % (5 * MIN) !== 0 || closeMs <= this.lastDetect || bars.length < 400) return;
    this.lastDetect = closeMs;
    const win = bars.slice(-WINDOW_BARS);
    for (const id of STRATEGIES) {
      if ([...this.open.values()].some((r) => r.strategy === id)) continue;
      await this.tryEnter(id, win, bars, closeMs);
    }
  }

  private async manage(run: FuturesRun, bars: Bar[]): Promise<void> {
    if (run.closing) return;
    let changed = false;
    let advanced = false;
    for (const b of bars) {
      if (b.t <= run.lastBarT) continue;
      advanced = true;
      const before = `${run.st.stop}|${run.st.best}|${run.st.breakevenDone}`;
      const ex = stepFutures(run.st, b, this.cfg);
      run.lastBarT = b.t;
      if (ex.exit) {
        await this.close(run, ex.price, ex.reason, ex.maker, b.t + MIN);
        return;
      }
      if (before !== `${run.st.stop}|${run.st.best}|${run.st.breakevenDone}`) changed = true;
    }
    if (changed || advanced) await this.persist(run);
  }

  private persisted(run: FuturesRun): PersistedFutures {
    return {
      kind: 'futures', st: run.st, leverage: run.leverage, stop0: run.stop0, target0: run.target0, lastBarT: run.lastBarT,
      entryFee: run.entryFee, note: run.note, confirmations: run.confirmations,
    };
  }

  private async persist(run: FuturesRun): Promise<void> {
    await updateExitConfig(run.id, this.persisted(run));
  }

  private async tryEnter(id: FuturesStrategy, win: Bar[], all: Bar[], closeMs: number): Promise<void> {
    let sig: FuturesSignal | null = null;
    const dateKey = istDateKey(closeMs - 1);
    if (id === 'FUT_SIGNAL') {
      const dayStart = istMidnightMs(dateKey);
      if ((await countRunsSince(id, dayStart)) >= this.cfg.signalMaxPerDay) return;
      if (closeMs - (await lastEntryMs(id)) < this.cfg.signalCooldownMin * MIN) return;
      const prevStart = istMidnightMs(istDateKey(dayStart - 1));
      let high = -Infinity;
      let low = Infinity;
      for (const b of all) {
        if (b.t >= prevStart && b.t < dayStart) {
          high = Math.max(high, b.h);
          low = Math.min(low, b.l);
        }
      }
      // Yesterday's range must be complete: the buffer has to reach back to yesterday's IST midnight.
      if (!Number.isFinite(high) || all[0]!.t > prevStart + 30 * MIN) return;
      sig = detectSignal({ bars1m: win, nowMs: closeMs, cfg: this.cfg, prevDay: { high, low, from: prevStart, to: dayStart } });
    } else {
      if (await runKeyExists(`${id}:${dateKey}:always`)) return;
      sig = detectSessionSweep(id, { bars1m: win, nowMs: closeMs, cfg: this.cfg });
    }
    if (!sig) return;
    const key = id === 'FUT_SIGNAL' ? `${id}:${dateKey}:${closeMs}` : `${id}:${dateKey}:always`;

    const plan = planTrade(sig, this.cfg);
    if (!plan.ok) {
      await logEvent({ strategy: id, type: 'entry_skipped', message: `${key}: ${plan.reason}; ${sig.note}` });
      if (id !== 'FUT_SIGNAL') {
        await insertRun({ runKey: key, strategy: id, book: 'always', mode: this.hooks.mode, dateKey, status: 'skipped', tags: { reason: plan.reason, note: sig.note } });
      }
      return;
    }
    const p = plan.plan;
    const book = await fetchBook('BTCUSD', 40);
    const w = walkBook(p.dir === 'long' ? book.asks : book.bids, p.lots, p.dir === 'long' ? 'buy' : 'sell');
    if (w.filled < p.lots || !Number.isFinite(w.avgPrice)) {
      await logEvent({ strategy: id, type: 'entry_failed', severity: 'warn', message: `${key}: perp book fills ${w.filled}/${p.lots} lots` });
      return;
    }
    const entry = w.avgPrice;
    const sgn = p.dir === 'long' ? 1 : -1;
    const marginUsd = (entry * p.lots * this.cfg.contractValue) / p.leverage;
    const verdict = await this.hooks.riskCheck(marginUsd, closeMs);
    if (!verdict.allowed) {
      await logEvent({ strategy: id, type: 'entry_blocked', severity: 'warn', message: `${key}: ${verdict.reasons.join('; ')}` });
      return;
    }
    const fee = futuresFee({ price: entry, lots: p.lots, contractValue: this.perp.contractValue, rate: this.perp.takerRate });
    const st: FuturesState = {
      dir: p.dir, entry, stop: entry - sgn * p.riskDist, target: entry + sgn * this.cfg.targetR * p.riskDist, riskDist: p.riskDist,
      lots: p.lots, openedAt: closeMs, best: entry, breakevenDone: false,
    };
    const conf = sig.confirmations.filter((c) => c.ok).map((c) => c.name);
    const persisted: PersistedFutures = {
      kind: 'futures', st, leverage: p.leverage, stop0: st.stop, target0: st.target, lastBarT: closeMs - MIN, entryFee: fee, note: sig.note, confirmations: conf,
    };
    const runId = await insertRun({
      runKey: key, strategy: id, book: 'always', mode: this.hooks.mode, dateKey, status: 'open', entryAtMs: closeMs,
      plannedExitAtMs: closeMs + this.cfg.maxHoldMin * MIN, spotEntry: entry, marginUsd, feesEntry: fee, exitConfig: persisted,
      tags: { signal: { note: sig.note, score: sig.score, confirmations: sig.confirmations }, leverage: p.leverage, riskUsd: p.riskAtStopUsd, intendedEntry: sig.entry, bookSlippage: w.slippage },
    });
    if (!runId) return;
    await insertLeg(runId, { symbol: 'BTCUSD', type: 'future', side: p.dir, role: 'body', strike: 0, expiryMs: 0, lots: p.lots, entryPrice: entry });
    await insertFill(runId, { legSymbol: 'BTCUSD', action: 'entry', side: p.dir === 'long' ? 'buy' : 'sell', lots: p.lots, intendedPrice: sig.entry, avgPrice: entry, filled: p.lots, partial: false, fee });
    this.open.set(runId, {
      id: runId, key, strategy: id, st, leverage: p.leverage, stop0: st.stop, target0: st.target, lastBarT: closeMs - MIN, entryFee: fee,
      marginUsd, note: sig.note, confirmations: conf, entryMs: closeMs, closing: false,
    });
    await logEvent({
      runId, strategy: id, type: 'entry',
      message: `${key} ${p.dir} ${p.lots} lots @ ${entry.toFixed(1)} stop ${st.stop.toFixed(1)} target ${st.target.toFixed(1)} (${p.leverage}x, risk ${p.riskAtStopUsd.toFixed(2)} USD): ${sig.note}`,
      data: { plan: p, confirmations: sig.confirmations },
    });
  }

  /** Close one position at a given price (a stop/target price from the exit stepper, or the last price for a flatten). */
  async close(run: FuturesRun, price: number, reason: string, maker: boolean, atMs: number): Promise<void> {
    if (run.closing) return;
    run.closing = true;
    const rate = maker ? this.perp.makerRate : this.perp.takerRate;
    const exitFee = futuresFee({ price, lots: run.st.lots, contractValue: this.perp.contractValue, rate });
    const pnl = futuresPnl(run.st.dir, run.st.entry, price, run.st.lots, run.entryFee, exitFee, this.perp.contractValue);
    await setLegExit(run.id, 'BTCUSD', price);
    await insertFill(run.id, { legSymbol: 'BTCUSD', action: 'exit', side: run.st.dir === 'long' ? 'sell' : 'buy', lots: run.st.lots, intendedPrice: price, avgPrice: price, filled: run.st.lots, partial: false, fee: exitFee });
    await closeRun(run.id, { exitAtMs: atMs, grossPnl: pnl.gross, netPnl: pnl.net, feesExit: exitFee, reason, detail: `${run.st.dir} closed at ${price.toFixed(1)} (${reason})` });
    this.open.delete(run.id);
    await logEvent({ runId: run.id, strategy: run.strategy, type: 'exit', message: `${run.key} closed (${reason}) at ${price.toFixed(1)}; net ${pnl.net.toFixed(2)} USD`, data: pnl });
  }

  /** Flatten everything at the last price (kill switch). */
  async flatten(now: number, reason: string): Promise<void> {
    const px = this.lastPrice();
    if (px == null) return;
    for (const run of [...this.open.values()]) await this.close(run, px, reason, false, now);
  }

  /** Per-minute record of each open futures position. */
  async record(minute: number): Promise<void> {
    const px = this.lastPrice();
    if (px == null) return;
    for (const run of this.open.values()) {
      const pnl = futuresPnl(run.st.dir, run.st.entry, px, run.st.lots, run.entryFee, 0, this.perp.contractValue);
      const sgn = run.st.dir === 'long' ? 1 : -1;
      const rNow = (sgn * (px - run.st.entry)) / run.st.riskDist;
      await upsertMark({
        runId: run.id, minuteMs: minute, netPnl: pnl.net, grossPnl: pnl.gross, pctMargin: run.marginUsd > 0 ? pnl.net / run.marginUsd : 0, spot: px,
        snapshot: {
          strategy: run.strategy, book: 'always', kind: 'futures', dir: run.st.dir, lots: run.st.lots, leverage: run.leverage, entry: run.st.entry,
          stop: run.st.stop, target: run.st.target, rMultiple: rNow, breakevenDone: run.st.breakevenDone, feesPaid: run.entryFee,
          minutesToExit: Math.round((run.st.openedAt + this.cfg.maxHoldMin * MIN - minute) / MIN), note: run.note,
          tpTargetUsd: null, tpRemainingUsd: null,
        },
      });
      await updatePeaks(run.id, pnl.net);
    }
  }

  /** Live view for the API. */
  positions() {
    const px = this.lastPrice();
    return [...this.open.values()].map((run) => {
      const pnl = px == null ? null : futuresPnl(run.st.dir, run.st.entry, px, run.st.lots, run.entryFee, 0, this.perp.contractValue);
      return {
        id: run.id, key: run.key, strategy: run.strategy, book: 'always', marginUsd: run.marginUsd, spot: px,
        legs: [{ symbol: 'BTCUSD', type: 'future', side: run.st.dir, role: 'body', lots: run.st.lots, entryPrice: run.st.entry, mark: px }],
        pnl: pnl ? { grossPnl: pnl.gross, netPnl: pnl.net, pctOfMargin: run.marginUsd > 0 ? pnl.net / run.marginUsd : 0 } : null,
        exit: { kind: 'futures', stop: run.st.stop, target: run.st.target, breakevenDone: run.st.breakevenDone },
        minutesToTimeExit: Math.round((run.st.openedAt + this.cfg.maxHoldMin * MIN - Date.now()) / MIN),
      };
    });
  }
}
