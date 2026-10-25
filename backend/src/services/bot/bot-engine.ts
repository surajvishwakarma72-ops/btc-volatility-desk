import { DEFAULT_CALENDAR, calendarBreakeven, isBackwardation } from '../../lib/bot/calendar.js';
import { calendarExitConfig, computePnl, evaluateExit, exitConfigFor } from '../../lib/bot/rules.js';
import { checkRisk, type PortfolioState, type RiskLimits } from '../../lib/bot/risk-guard.js';
import { dueCalendar, dueEntries, floorToMinute, istDateKey, istMidnightMs, runKey, runWindow, DAY, MIN, type RunWindow } from '../../lib/bot/schedule.js';
import { portfolioMargin, type MarginPosition } from '../../lib/bot/portfolio-margin.js';
import { pickAtmStraddle, pickBodyLeg, type ChainOption } from '../../lib/bot/strike-picker.js';
import type { ExitConfig, Leg, StrategyId } from '../../lib/bot/types.js';
import type { LearnParams } from '../../lib/bot/learn.js';
import {
  closeRun, getConfig, getOpenRuns, getParams, getShadowCandidates, insertFill, insertLeg, insertRun, insertShadow, lastLearningMs,
  logEvent, pnlSince, runKeyExists, setLegExit, updatePeaks, upsertContext, upsertMark, ensureBotSchema,
} from './bot-store.js';
import { LEARNED_STRATEGIES, autoLearnOn, runLearning } from './learner.js';
import { fetchBook, fetchChain, fetchOptionFeeRates, type Book, type ChainSnapshot } from './delta-public.js';
import { FuturesLive } from './futures-live.js';
import { evaluateGate } from './gate.js';
import { paperExecute, type PlannedLeg } from './paper-broker.js';

const LOTS = Number(process.env.BOT_OPTION_LOTS ?? 100);
const CONTRACT_VALUE = 0.001;
const TICK_MS = 5_000;

type OptionStrategy = Exclude<StrategyId, 'CAL_BACK'>;

const SHORT_VOL: ReadonlySet<StrategyId> = new Set(['ASIA_SHORT', 'NY_SHORT', 'CAL_BACK']);
const isLong = (id: StrategyId) => id === 'EVE_LONG' || id === 'PRE_LONG';

const LIMITS: RiskLimits = {
  maxOpenMarginUsd: Number(process.env.BOT_MAX_MARGIN_USD ?? 5000),
  maxOpenPositions: Number(process.env.BOT_MAX_POSITIONS ?? 14),
  maxDailyLossUsd: Number(process.env.BOT_MAX_DAILY_LOSS_USD ?? 300),
  maxMonthlyLossUsd: Number(process.env.BOT_MAX_MONTHLY_LOSS_USD ?? 900),
};

interface OpenRun {
  id: string;
  key: string;
  strategy: StrategyId;
  book: string;
  legs: Leg[];
  exitCfg: ExitConfig;
  marginUsd: number;
  feesEntry: number;
  closing: boolean;
}

interface WaitState {
  lastMinute: number;
  attempts: number;
  /** Each distinct reason the entry was declined, in order, with when it was first seen. */
  reasons: Array<{ atMs: number; reason: string }>;
  windowEndMs: number;
}

/**
 * Paper trading engine. Strategy code is pure (lib/bot); this class only schedules, fetches
 * market data, and persists. Nothing here can place a real order: live mode is not implemented
 * and the engine refuses to start in any mode but `paper`.
 */
export class BotEngine {
  status: 'stopped' | 'running' | 'error' = 'stopped';
  lastTickAt = 0;
  lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private open = new Map<string, OpenRun>();
  private waits = new Map<string, WaitState>();
  /** Early-closed always-book runs whose marks are still recorded to their planned exit, so other rules can be replayed over the whole day. */
  private shadows = new Map<string, { id: string; legs: Leg[]; plannedExitAtMs: number }>();
  private paramCache = new Map<string, { at: number; params: LearnParams }>();
  private learnedDay = '';
  private chain: ChainSnapshot | null = null;
  private lastMinute = 0;
  readonly futures = new FuturesLive({
    mode: 'paper',
    riskCheck: async (marginUsd, now) =>
      checkRisk({ strategy: 'FUTURES', marginUsd, shortVol: false }, await this.portfolioState(now), LIMITS, { eventInWindow: false }),
  });

  get enabled(): boolean {
    return process.env.BOT_ENABLED === 'true';
  }

  async start(): Promise<void> {
    if (!this.enabled || this.timer) return;
    const mode = process.env.BOT_MODE ?? 'paper';
    if (mode !== 'paper') {
      this.status = 'error';
      this.lastError = `BOT_MODE=${mode} is not supported yet; only paper is implemented`;
      console.error(`[bot] ${this.lastError}`);
      return;
    }
    try {
      await ensureBotSchema();
      await this.restore();
    } catch (e) {
      this.status = 'error';
      this.lastError = `startup failed: ${(e as Error).message}`;
      console.error('[bot]', this.lastError);
      return;
    }
    this.status = 'running';
    console.log(`[bot] paper engine started (${this.open.size} open run(s) restored, ${LOTS} lots/leg)`);
    await logEvent({ type: 'engine_start', message: `paper engine started, ${this.open.size} open runs restored` });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = 'stopped';
  }

  private async restore(): Promise<void> {
    this.open.clear();
    this.futures.open.clear();
    const futRows: Array<(typeof rows)[number]> = [];
    const rows = await getOpenRuns();
    for (const r of rows) {
      if (r.strategy.startsWith('FUT_')) {
        futRows.push(r);
        continue;
      }
      this.open.set(r.id, {
        id: r.id,
        key: r.run_key,
        strategy: r.strategy as StrategyId,
        book: r.book,
        legs: r.legs.map((l) => ({
          symbol: l.symbol,
          type: l.type as Leg['type'],
          side: l.side as Leg['side'],
          strike: Number(l.strike),
          expiryMs: Number(l.expiry_ms),
          lots: l.lots,
          entryPrice: Number(l.entry_price),
          role: l.role as Leg['role'],
        })),
        exitCfg: (r.exit_config as ExitConfig) ?? {},
        marginUsd: Number(r.margin_usd ?? 0),
        feesEntry: Number(r.fees_entry ?? 0),
        closing: false,
      });
    }
    this.futures.restore(futRows);
    this.shadows.clear();
    for (const r of await getShadowCandidates(Date.now())) {
      this.shadows.set(r.id, {
        id: r.id,
        legs: r.legs.map((l) => ({
          symbol: l.symbol, type: l.type as Leg['type'], side: l.side as Leg['side'], strike: Number(l.strike), expiryMs: Number(l.expiry_ms),
          lots: l.lots, entryPrice: Number(l.entry_price), role: l.role as Leg['role'],
        })),
        plannedExitAtMs: new Date(r.planned_exit_at!).getTime(),
      });
    }
  }

  /** The learned rules for a strategy (the auto-learn champion), cached for a short while. */
  private async paramsFor(id: StrategyId): Promise<LearnParams> {
    const hit = this.paramCache.get(id);
    if (hit && Date.now() - hit.at < 30_000) return hit.params;
    const params = await getParams(id);
    this.paramCache.set(id, { at: Date.now(), params });
    return params;
  }

  /** Once a day after the New York trade has closed: replay the challengers over the recorded days and promote a winner if one clears every bar. */
  private async maybeLearn(now: number): Promise<void> {
    const today = istDateKey(now);
    if (this.learnedDay === today || (now - istMidnightMs(today)) / MIN < 9 * 60 + 30) return;
    this.learnedDay = today;
    try {
      const ran = await lastLearningMs(LEARNED_STRATEGIES[0], 'evaluation');
      if (ran != null && ran >= istMidnightMs(today)) return;
      const reports = await runLearning(now, autoLearnOn());
      for (const r of reports) this.paramCache.delete(r.strategy);
    } catch (e) {
      await logEvent({ type: 'learn_error', severity: 'warn', message: `auto-learn failed: ${(e as Error).message}` });
    }
  }

  private async getChain(maxAgeMs = 4_000): Promise<ChainSnapshot> {
    if (this.chain && Date.now() - this.chain.fetchedAt < maxAgeMs) return this.chain;
    this.chain = await fetchChain();
    return this.chain;
  }

  async tick(): Promise<void> {
    if (this.busy || this.status !== 'running') return;
    this.busy = true;
    const now = Date.now();
    try {
      const cfg = await getConfig();
      this.lastTickAt = now;
      const errors: string[] = [];

      // Options (strategies on the Delta option chain). A chain outage must not stop the futures engine.
      let chain: ChainSnapshot | null = null;
      try {
        chain = await this.getChain();
        if (cfg.kill_switch) {
          for (const run of this.open.values()) await this.exit(run, chain, now, 'stop', 'kill switch');
        } else {
          if (!cfg.paused) {
            for (const due of dueEntries(now)) {
              for (const book of ['always', 'gated'] as const) {
                if (book === 'gated' && !SHORT_VOL.has(due.id)) continue;
                await this.enter(due.id, due.dateKey, book, due.window, chain, now, due.final, due.windowEndMs);
              }
            }
            const cal = dueCalendar(now);
            if (cal) {
              const front = chain.expiries[0];
              if (front) await this.enter('CAL_BACK', cal.dateKey, 'always', { entryAtMs: cal.entryAtMs, exitAtMs: front - DEFAULT_CALENDAR.hardCloseBeforeMs }, chain, now, true, cal.entryAtMs + 10 * MIN);
            }
          }
          for (const run of [...this.open.values()]) await this.monitor(run, chain, now);
        }
      } catch (e) {
        errors.push(`options: ${(e as Error).message}`);
      }

      // Futures (1m candles + the perpetual order book).
      try {
        if (cfg.kill_switch) await this.futures.flatten(now, 'kill switch');
        else await this.futures.tick(now, { allowEntries: !cfg.paused });
      } catch (e) {
        errors.push(`futures: ${(e as Error).message}`);
      }

      if (!cfg.kill_switch) await this.maybeLearn(now);

      this.lastError = errors.length ? errors.join(' | ') : null;
      if (errors.length) {
        console.error('[bot] tick failed:', this.lastError);
        await logEvent({ type: 'tick_error', severity: 'error', message: this.lastError! });
      }

      const minute = floorToMinute(now);
      if (minute > this.lastMinute) {
        this.lastMinute = minute;
        if (chain) await this.record(minute, chain, now);
        try { await this.futures.record(minute); } catch (e) { console.error('[bot] futures record failed', (e as Error).message); }
      }
    } catch (e) {
      this.lastError = (e as Error).message;
      console.error('[bot] tick failed:', this.lastError);
      await logEvent({ type: 'tick_error', severity: 'error', message: this.lastError });
    } finally {
      this.busy = false;
    }
  }

  // ---------- entries ----------

  /** ATM straddle calendar: sell the current expiry, buy N2N, same strike, both call and put. */
  private planCalendar(chain: ChainSnapshot): { legs: PlannedLeg[]; expiryMs: number } | { skip: string } | null {
    const [front, , back] = chain.expiries;
    if (!front || !back) return null;
    const at = (exp: number, K: number, type: 'call' | 'put') => chain.options.find((o) => o.expiryMs === exp && o.strike === K && o.type === type);
    const strikes = [...new Set(chain.options.filter((o) => o.expiryMs === front).map((o) => o.strike))].sort((x, y) => Math.abs(x - chain.spot) - Math.abs(y - chain.spot));
    for (const K of strikes) {
      const fc = at(front, K, 'call');
      const fp = at(front, K, 'put');
      const bc = at(back, K, 'call');
      const bp = at(back, K, 'put');
      if (!fc || !fp || !bc || !bp || fc.bid <= 0 || fp.bid <= 0 || bc.ask <= 0 || bp.ask <= 0) continue;
      const frontIv = (fc.iv + fp.iv) / 2;
      const backIv = (bc.iv + bp.iv) / 2;
      if (!isBackwardation(frontIv, backIv, DEFAULT_CALENDAR.minBackwardation)) {
        return { skip: `no backwardation: front IV ${frontIv.toFixed(1)} vs back IV ${backIv.toFixed(1)} (need +${DEFAULT_CALENDAR.minBackwardation} pts)` };
      }
      const leg = (o: ChainOption, side: 'long' | 'short', role: 'front' | 'back'): PlannedLeg => ({
        symbol: o.symbol, type: o.type, side, strike: o.strike, expiryMs: o.expiryMs, lots: LOTS, role, intendedPrice: side === 'short' ? o.bid : o.ask,
      });
      return { legs: [leg(fc, 'short', 'front'), leg(fp, 'short', 'front'), leg(bc, 'long', 'back'), leg(bp, 'long', 'back')], expiryMs: front };
    }
    return null;
  }

  private plan(id: StrategyId, chain: ChainSnapshot): { legs: PlannedLeg[]; expiryMs: number } | { skip: string } | null {
    if (id === 'CAL_BACK') return this.planCalendar(chain);
    const ex = chain.expiries;
    if (isLong(id)) {
      const expiryMs = ex[1];
      if (!expiryMs) return null;
      const s = pickAtmStraddle(chain.options, expiryMs, chain.spot);
      if (!s) return null;
      const mk = (o: ChainOption): PlannedLeg => ({
        symbol: o.symbol, type: o.type, side: 'long', strike: o.strike, expiryMs, lots: LOTS, role: 'body', intendedPrice: o.ask,
      });
      return { legs: [mk(s.call), mk(s.put)], expiryMs };
    }
    const expiryMs = ex[2];
    if (!expiryMs) return null;
    const call = pickBodyLeg(chain.options, 'call', expiryMs);
    const put = pickBodyLeg(chain.options, 'put', expiryMs);
    if (!call || !put) return null;
    const body = (o: ChainOption): PlannedLeg => ({
      symbol: o.symbol, type: o.type, side: 'short', strike: o.strike, expiryMs, lots: LOTS, role: 'body', intendedPrice: o.bid,
    });
    return { legs: [body(call), body(put)], expiryMs };
  }

  private async portfolioState(now: number): Promise<PortfolioState> {
    const dayStart = istMidnightMs(istDateKey(now));
    const cfg = await getConfig();
    return {
      openMarginUsd: [...this.open.values()].reduce((s, r) => s + r.marginUsd, 0) + this.futures.summary().margin,
      openPositions: this.open.size + this.futures.summary().positions,
      dailyPnlUsd: await pnlSince(dayStart),
      monthlyPnlUsd: await pnlSince(now - 30 * 86_400_000),
      paused: cfg.paused,
      killSwitch: cfg.kill_switch,
    };
  }

  /** Entries still waiting for their conditions (short strangles keep trying through their wait window). */
  waitingEntries() {
    return [...this.waits.entries()].map(([key, s]) => ({
      key, attempts: s.attempts, lastReason: s.reasons.at(-1)?.reason ?? null, reasonsSeen: s.reasons, windowEndMs: s.windowEndMs,
    }));
  }

  /**
   * One entry attempt. A strategy with a wait window is retried once a minute until it enters or the window
   * closes; only then is the day recorded as dropped, with every distinct reason seen on the way.
   */
  private async enter(
    id: StrategyId, dateKey: string, book: 'always' | 'gated', w: RunWindow, chain: ChainSnapshot, now: number,
    final: boolean, windowEndMs: number,
  ): Promise<void> {
    const key = runKey(id, dateKey, book);
    const minute = floorToMinute(now);
    const st = this.waits.get(key) ?? { lastMinute: 0, attempts: 0, reasons: [], windowEndMs };
    if (st.lastMinute === minute) return;
    if (await runKeyExists(key)) { this.waits.delete(key); return; }
    st.attempts++;
    this.waits.set(key, st);
    const done = await this.tryEnter(id, dateKey, book, w, chain, now, key, st, final);
    if (done) this.waits.delete(key);
    else st.lastMinute = minute;
  }

  /** Records why an attempt did not trade; returns true once the drop is final (and persisted). */
  private async decline(
    st: WaitState, key: string, id: StrategyId, dateKey: string, book: 'always' | 'gated', final: boolean,
    status: 'skipped' | 'failed', reason: string, tags: Record<string, unknown>, now: number, eventType: string,
  ): Promise<boolean> {
    const changed = st.reasons.at(-1)?.reason !== reason;
    if (changed) st.reasons.push({ atMs: now, reason });
    if (changed || final) {
      await logEvent({
        strategy: id, type: final ? eventType : 'entry_waiting', severity: status === 'failed' ? 'warn' : 'info',
        message: final ? `${key}: dropped, ${reason}` : `${key}: not entered yet, ${reason}; trying again until ${new Date(st.windowEndMs + 19_800_000).toISOString().slice(11, 16)} IST`,
      });
    }
    if (!final) return false;
    await insertRun({
      runKey: key, strategy: id, book, mode: 'paper', dateKey, status,
      tags: { ...tags, reason, attempts: st.attempts, reasonsSeen: st.reasons },
    });
    return true;
  }

  private async tryEnter(
    id: StrategyId, dateKey: string, book: 'always' | 'gated', w: RunWindow, chain: ChainSnapshot, now: number,
    key: string, st: WaitState, final: boolean,
  ): Promise<boolean> {
    const mode = 'paper';
    const learned = await this.paramsFor(id);
    const gate = evaluateGate(learned.dvolMax);
    const tags = { gate, expiries: chain.expiries.slice(0, 4) };

    if (book === 'gated' && !gate.go) {
      return this.decline(st, key, id, dateKey, book, final, 'skipped', `gate WAIT (${gate.reasons.join('; ')})`, tags, now, 'entry_skipped');
    }

    const plan = this.plan(id, chain);
    if (plan && 'skip' in plan) {
      return this.decline(st, key, id, dateKey, book, final, 'skipped', plan.skip, tags, now, 'entry_skipped');
    }
    if (!plan) {
      return this.decline(st, key, id, dateKey, book, final, 'failed', 'no tradable strikes or expiry in the chain (short strangles need a 0.10-0.15 delta strike with a bid)', tags, now, 'entry_failed');
    }

    const symbols = plan.legs.map((l) => l.symbol);
    const [books, rates] = await Promise.all([
      Promise.all(symbols.map(async (s) => [s, await fetchBook(s)] as const)).then((e) => new Map<string, Book>(e)),
      fetchOptionFeeRates(symbols),
    ]);
    const exec = paperExecute(plan.legs, 'entry', books, rates, chain.spot);
    if (!exec.ok) {
      return this.decline(st, key, id, dateKey, book, final, 'failed', `order book not fillable: ${exec.reason}`, tags, now, 'entry_failed');
    }

    const legs: Leg[] = plan.legs.map((l, i) => ({
      symbol: l.symbol, type: l.type, side: l.side, strike: l.strike, expiryMs: l.expiryMs, lots: l.lots,
      entryPrice: exec.fills[i]!.avgPrice, role: l.role,
    }));
    const marginUsd = this.marginOf(legs, chain, now).margin;

    const verdict = checkRisk(
      { strategy: id, marginUsd, shortVol: SHORT_VOL.has(id) },
      await this.portfolioState(now),
      LIMITS,
      { eventInWindow: gate.eventInWindow },
    );
    if (!verdict.allowed) {
      return this.decline(st, key, id, dateKey, book, final, 'skipped', `risk guard blocked: ${verdict.reasons.join('; ')}`, { ...tags, blocked: verdict.reasons }, now, 'entry_blocked');
    }

    let exitCfg: ExitConfig;
    if (id === 'CAL_BACK') {
      const by = new Map(chain.options.map((o) => [o.symbol, o]));
      const f0 = legs[0]!;
      const b0 = legs[2]!;
      const netDebit = legs.filter((l) => l.side === 'long').reduce((s, l) => s + l.entryPrice, 0) - legs.filter((l) => l.side === 'short').reduce((s, l) => s + l.entryPrice, 0);
      const be = calendarBreakeven(
        { strike: f0.strike, frontExpiryMs: f0.expiryMs, backExpiryMs: b0.expiryMs, frontIv: by.get(f0.symbol)?.iv || 40, backIv: by.get(b0.symbol)?.iv || 40 },
        netDebit,
      );
      if (!be) {
        return this.decline(st, key, id, dateKey, book, final, 'skipped', `the net debit ${netDebit.toFixed(1)} cannot be repaid at front expiry (no profit zone)`, tags, now, 'entry_skipped');
      }
      exitCfg = calendarExitConfig({ low: be.low, high: be.high }, f0.expiryMs);
    } else {
      exitCfg = exitConfigFor(id, w.exitAtMs, learned);
    }
    const runId = await insertRun({
      runKey: key, strategy: id, book, mode, dateKey, status: 'open', entryAtMs: now, plannedExitAtMs: w.exitAtMs,
      spotEntry: chain.spot, marginUsd, feesEntry: exec.fees, exitConfig: exitCfg,
      tags: st.attempts > 1 || st.reasons.length
        ? { ...tags, enteredAfterWaitMin: Math.round((now - w.entryAtMs) / MIN), attempts: st.attempts, reasonsBeforeEntry: st.reasons }
        : tags,
    });
    if (!runId) return true;
    for (const l of legs) await insertLeg(runId, l);
    for (const f of exec.fills) {
      await insertFill(runId, { legSymbol: f.symbol, action: 'entry', side: f.side, lots: f.lots, intendedPrice: f.intendedPrice, avgPrice: f.avgPrice, filled: f.filled, partial: f.partial, fee: f.fee });
    }
    this.open.set(runId, { id: runId, key, strategy: id, book, legs, exitCfg, marginUsd, feesEntry: exec.fees, closing: false });
    await logEvent({
      runId, strategy: id, type: 'entry',
      message: `${key} entered: ${legs.map((l) => `${l.side} ${l.symbol}@${l.entryPrice.toFixed(1)}`).join(', ')}; margin ${marginUsd.toFixed(2)}`,
      data: { legs, marginUsd, fees: exec.fees, spot: chain.spot, gate: gate.go },
    });
    return true;
  }

  // ---------- monitoring and exits ----------

  private marksFor(run: OpenRun, chain: ChainSnapshot) {
    const by = new Map(chain.options.map((o) => [o.symbol, o]));
    return run.legs.map((l) => ({ symbol: l.symbol, mark: by.get(l.symbol)?.mark ?? NaN }));
  }

  private marginOf(legs: Leg[], chain: ChainSnapshot, now: number) {
    const by = new Map(chain.options.map((o) => [o.symbol, o]));
    const pos: MarginPosition[] = legs.map((l) => ({
      type: l.type, side: l.side, strike: l.strike, expiryMs: l.expiryMs, lots: l.lots, iv: by.get(l.symbol)?.iv || 40,
    }));
    return portfolioMargin(pos, chain.spot, now, CONTRACT_VALUE);
  }

  private async monitor(run: OpenRun, chain: ChainSnapshot, now: number): Promise<void> {
    if (run.closing) return;
    const marks = this.marksFor(run, chain);
    if (marks.some((m) => !Number.isFinite(m.mark))) {
      await logEvent({ runId: run.id, strategy: run.strategy, type: 'mark_missing', severity: 'warn', message: `${run.key}: a leg has no mark in the chain` });
      return;
    }
    const snap = { legs: run.legs, marks, spot: chain.spot, marginUsd: run.marginUsd, contractValue: CONTRACT_VALUE, feesPaidUsd: run.feesEntry };
    const d = evaluateExit(snap, run.exitCfg, now);
    if (d.action === 'exit') await this.exit(run, chain, now, d.reason, d.detail);
  }

  private async exit(run: OpenRun, chain: ChainSnapshot, now: number, reason: string, detail: string): Promise<void> {
    if (run.closing) return;
    run.closing = true;
    try {
      const marks = this.marksFor(run, chain);
      const planned: PlannedLeg[] = run.legs.map((l, i) => ({
        symbol: l.symbol, type: l.type, side: l.side, strike: l.strike, expiryMs: l.expiryMs, lots: l.lots, role: l.role, intendedPrice: marks[i]!.mark,
      }));
      const symbols = planned.map((l) => l.symbol);
      const [books, rates] = await Promise.all([
        Promise.all(symbols.map(async (s) => [s, await fetchBook(s)] as const)).then((e) => new Map<string, Book>(e)),
        fetchOptionFeeRates(symbols),
      ]);
      const exec = paperExecute(planned, 'exit', books, rates, chain.spot);
      if (!exec.ok) {
        // Retry on the next tick; the stop condition will still hold.
        await logEvent({ runId: run.id, strategy: run.strategy, type: 'exit_retry', severity: 'warn', message: `${run.key}: exit not fillable yet (${exec.reason})` });
        run.closing = false;
        return;
      }
      let gross = 0;
      for (let i = 0; i < run.legs.length; i++) {
        const leg = run.legs[i]!;
        const px = exec.fills[i]!.avgPrice;
        gross += (leg.side === 'short' ? leg.entryPrice - px : px - leg.entryPrice) * leg.lots * CONTRACT_VALUE;
        await setLegExit(run.id, leg.symbol, px);
        const f = exec.fills[i]!;
        await insertFill(run.id, { legSymbol: f.symbol, action: 'exit', side: f.side, lots: f.lots, intendedPrice: f.intendedPrice, avgPrice: f.avgPrice, filled: f.filled, partial: f.partial, fee: f.fee });
      }
      const net = gross - run.feesEntry - exec.fees;
      await closeRun(run.id, { exitAtMs: now, grossPnl: gross, netPnl: net, feesExit: exec.fees, reason, detail });
      this.open.delete(run.id);
      const plannedExit = run.exitCfg.exitAtMs;
      if (run.book === 'always' && (LEARNED_STRATEGIES as readonly string[]).includes(run.strategy) && plannedExit != null && plannedExit > now + MIN) {
        this.shadows.set(run.id, { id: run.id, legs: run.legs, plannedExitAtMs: plannedExit });
      }
      await logEvent({ runId: run.id, strategy: run.strategy, type: 'exit', message: `${run.key} closed (${reason}): ${detail}; net ${net.toFixed(2)} USD`, data: { gross, net, fees: run.feesEntry + exec.fees } });
    } catch (e) {
      run.closing = false;
      throw e;
    }
  }

  // ---------- minute recorder ----------

  private async record(minute: number, chain: ChainSnapshot, now: number): Promise<void> {
    const by = new Map(chain.options.map((o) => [o.symbol, o]));
    const allLegs: Leg[] = [];
    for (const run of this.open.values()) {
      allLegs.push(...run.legs);
      const marks = this.marksFor(run, chain);
      const snap = { legs: run.legs, marks, spot: chain.spot, marginUsd: run.marginUsd, contractValue: CONTRACT_VALUE, feesPaidUsd: run.feesEntry };
      if (marks.some((m) => !Number.isFinite(m.mark))) continue;
      const pnl = computePnl(snap);
      const legsOut = run.legs.map((l) => {
        const o = by.get(l.symbol);
        const g = chain.greeks.get(l.symbol);
        return {
          symbol: l.symbol, side: l.side, role: l.role, entry: l.entryPrice, mark: o?.mark ?? null, bid: o?.bid ?? null, ask: o?.ask ?? null,
          iv: o?.iv ?? null, delta: g?.delta ?? null, gamma: g?.gamma ?? null, theta: g?.theta ?? null, vega: g?.vega ?? null,
          pnl: pnl.perLeg.find((p) => p.symbol === l.symbol)?.pnl ?? null,
        };
      });
      const tpTarget = run.exitCfg.tpPctOfMargin != null ? run.exitCfg.tpPctOfMargin * run.marginUsd : null;
      const stopLevels = run.exitCfg.stopMultiple != null
        ? run.legs.filter((l) => l.side === 'short' && l.role === 'body').map((l) => ({ symbol: l.symbol, stopAt: l.entryPrice * run.exitCfg.stopMultiple!, distance: l.entryPrice * run.exitCfg.stopMultiple! - (by.get(l.symbol)?.mark ?? NaN) }))
        : [];
      await upsertMark({
        runId: run.id, minuteMs: minute, netPnl: pnl.netPnl, grossPnl: pnl.grossPnl, pctMargin: pnl.pctOfMargin, spot: chain.spot,
        snapshot: { strategy: run.strategy, book: run.book, feesPaid: run.feesEntry, marginUsd: run.marginUsd, tpTargetUsd: tpTarget, tpRemainingUsd: tpTarget != null ? tpTarget - pnl.netPnl : null, stopLevels, legs: legsOut, minutesToExit: run.exitCfg.exitAtMs ? Math.round((run.exitCfg.exitAtMs - now) / MIN) : null },
      });
      await updatePeaks(run.id, pnl.netPnl);
    }
    for (const s of [...this.shadows.values()]) {
      if (minute > s.plannedExitAtMs) { this.shadows.delete(s.id); continue; }
      const marks = s.legs.map((l) => by.get(l.symbol)?.mark ?? NaN);
      if (marks.every(Number.isFinite)) await insertShadow(s.id, minute, chain.spot, marks);
    }
    const gate = evaluateGate();
    const account = allLegs.length ? this.marginOf(allLegs, chain, now) : null;
    await upsertContext(minute, chain.spot, {
      istHour: new Date(minute + 19_800_000).getUTCHours(),
      gate,
      expiries: chain.expiries.slice(0, 4),
      openRuns: this.open.size,
      accountMargin: account ? { margin: account.margin, risk: account.riskMargin, floor: account.floor } : null,
      nextEntries: (['ASIA_SHORT', 'NY_SHORT', 'EVE_LONG', 'PRE_LONG'] as OptionStrategy[]).map((id) => {
        const today = runWindow(id, istDateKey(now)).entryAtMs;
        return { id, nextEntryAt: today >= now ? today : runWindow(id, istDateKey(now + DAY)).entryAtMs };
      }),
    });
  }

  /** Live view for the API: open runs with current marks, computed from the latest chain. */
  async livePositions() {
    const now = Date.now();
    const futures = this.futures.positions();
    if (!this.open.size) return futures;
    const chain = await this.getChain(10_000);
    const options = [...this.open.values()].map((run) => {
      const marks = this.marksFor(run, chain);
      const ok = marks.every((m) => Number.isFinite(m.mark));
      const snap = { legs: run.legs, marks, spot: chain.spot, marginUsd: run.marginUsd, contractValue: CONTRACT_VALUE, feesPaidUsd: run.feesEntry };
      const pnl = ok ? computePnl(snap) : null;
      return {
        id: run.id, key: run.key, strategy: run.strategy, book: run.book, marginUsd: run.marginUsd, spot: chain.spot,
        legs: run.legs.map((l, i) => ({ ...l, mark: marks[i]!.mark })),
        pnl, exit: run.exitCfg,
        minutesToTimeExit: run.exitCfg.exitAtMs ? Math.round((run.exitCfg.exitAtMs - now) / MIN) : null,
      };
    });
    return [...options, ...futures];
  }
}

export const botEngine = new BotEngine();
