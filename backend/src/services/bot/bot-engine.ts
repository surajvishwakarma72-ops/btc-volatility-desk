import { computePnl, evaluateExit, exitConfigFor } from '../../lib/bot/rules.js';
import { checkRisk, type RiskLimits } from '../../lib/bot/risk-guard.js';
import { dueEntries, floorToMinute, istDateKey, istMidnightMs, runKey, runWindow, DAY, MIN, type RunWindow } from '../../lib/bot/schedule.js';
import { portfolioMargin, type MarginPosition } from '../../lib/bot/portfolio-margin.js';
import { pickAtmStraddle, pickBodyLeg, pickWing, type ChainOption } from '../../lib/bot/strike-picker.js';
import type { ExitConfig, Leg, StrategyId } from '../../lib/bot/types.js';
import {
  closeRun, getConfig, getOpenRuns, insertFill, insertLeg, insertRun, logEvent, pnlSince, runKeyExists, setLegExit,
  updatePeaks, upsertContext, upsertMark, ensureBotSchema,
} from './bot-store.js';
import { fetchBook, fetchChain, fetchOptionFeeRates, type Book, type ChainSnapshot } from './delta-public.js';
import { evaluateGate } from './gate.js';
import { paperExecute, type PlannedLeg } from './paper-broker.js';

const LOTS = Number(process.env.BOT_OPTION_LOTS ?? 100);
const CONTRACT_VALUE = 0.001;
const TICK_MS = 5_000;

type OptionStrategy = Exclude<StrategyId, 'CAL_BACK'>;

const SHORT_VOL: ReadonlySet<StrategyId> = new Set(['ASIA_SHORT', 'NY_SHORT', 'ASIA_IC', 'NY_IC']);
const isIronCondor = (id: StrategyId) => id === 'ASIA_IC' || id === 'NY_IC';
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
  private chain: ChainSnapshot | null = null;
  private lastMinute = 0;

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
    for (const r of await getOpenRuns()) {
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
      const chain = await this.getChain();
      this.lastTickAt = now;
      this.lastError = null;

      if (cfg.kill_switch) {
        for (const run of this.open.values()) await this.exit(run, chain, now, 'stop', 'kill switch');
      } else {
        if (!cfg.paused) {
          for (const due of dueEntries(now)) {
            for (const book of ['always', 'gated'] as const) {
              if (book === 'gated' && !SHORT_VOL.has(due.id)) continue;
              await this.enter(due.id, due.dateKey, book, due.window, chain, now);
            }
          }
        }
        for (const run of [...this.open.values()]) await this.monitor(run, chain, now);
      }

      const minute = floorToMinute(now);
      if (minute > this.lastMinute) {
        this.lastMinute = minute;
        await this.record(minute, chain, now);
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

  private plan(id: OptionStrategy, chain: ChainSnapshot): { legs: PlannedLeg[]; expiryMs: number } | null {
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
    const legs = [body(call), body(put)];
    if (isIronCondor(id)) {
      const wc = pickWing(chain.options, call);
      const wp = pickWing(chain.options, put);
      if (!wc || !wp) return null;
      for (const w of [wc, wp]) {
        legs.push({ symbol: w.symbol, type: w.type, side: 'long', strike: w.strike, expiryMs, lots: LOTS, role: 'wing', intendedPrice: w.ask });
      }
    }
    return { legs, expiryMs };
  }

  private async portfolioState(now: number) {
    const dayStart = istMidnightMs(istDateKey(now));
    const cfg = await getConfig();
    return {
      openMarginUsd: [...this.open.values()].reduce((s, r) => s + r.marginUsd, 0),
      openPositions: this.open.size,
      dailyPnlUsd: await pnlSince(dayStart),
      monthlyPnlUsd: await pnlSince(now - 30 * 86_400_000),
      paused: cfg.paused,
      killSwitch: cfg.kill_switch,
    };
  }

  private async enter(id: OptionStrategy, dateKey: string, book: 'always' | 'gated', w: RunWindow, chain: ChainSnapshot, now: number): Promise<void> {
    const key = runKey(id, dateKey, book);
    if (await runKeyExists(key)) return;
    const mode = 'paper';
    const gate = evaluateGate();
    const tags = { gate, expiries: chain.expiries.slice(0, 4) };

    if (book === 'gated' && !gate.go) {
      await insertRun({ runKey: key, strategy: id, book, mode, dateKey, status: 'skipped', tags });
      await logEvent({ strategy: id, type: 'entry_skipped', message: `${key}: gate WAIT (${gate.reasons.join('; ')})`, data: gate });
      return;
    }

    const plan = this.plan(id, chain);
    if (!plan) {
      await insertRun({ runKey: key, strategy: id, book, mode, dateKey, status: 'failed', tags });
      await logEvent({ strategy: id, type: 'entry_failed', severity: 'warn', message: `${key}: no tradable strikes/expiry in the chain` });
      return;
    }

    const symbols = plan.legs.map((l) => l.symbol);
    const [books, rates] = await Promise.all([
      Promise.all(symbols.map(async (s) => [s, await fetchBook(s)] as const)).then((e) => new Map<string, Book>(e)),
      fetchOptionFeeRates(symbols),
    ]);
    const exec = paperExecute(plan.legs, 'entry', books, rates, chain.spot);
    if (!exec.ok) {
      await insertRun({ runKey: key, strategy: id, book, mode, dateKey, status: 'failed', tags: { ...tags, reason: exec.reason } });
      await logEvent({ strategy: id, type: 'entry_failed', severity: 'warn', message: `${key}: ${exec.reason}` });
      return;
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
      await insertRun({ runKey: key, strategy: id, book, mode, dateKey, status: 'skipped', tags: { ...tags, blocked: verdict.reasons } });
      await logEvent({ strategy: id, type: 'entry_blocked', severity: 'warn', message: `${key}: ${verdict.reasons.join('; ')}` });
      return;
    }

    const exitCfg = exitConfigFor(id, w.exitAtMs);
    const runId = await insertRun({
      runKey: key, strategy: id, book, mode, dateKey, status: 'open', entryAtMs: now, plannedExitAtMs: w.exitAtMs,
      spotEntry: chain.spot, marginUsd, feesEntry: exec.fees, exitConfig: exitCfg, tags,
    });
    if (!runId) return;
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
    const gate = evaluateGate();
    const account = allLegs.length ? this.marginOf(allLegs, chain, now) : null;
    await upsertContext(minute, chain.spot, {
      istHour: new Date(minute + 19_800_000).getUTCHours(),
      gate,
      expiries: chain.expiries.slice(0, 4),
      openRuns: this.open.size,
      accountMargin: account ? { margin: account.margin, risk: account.riskMargin, floor: account.floor } : null,
      nextEntries: (['ASIA_SHORT', 'NY_SHORT', 'EVE_LONG', 'PRE_LONG', 'ASIA_IC', 'NY_IC'] as OptionStrategy[]).map((id) => {
        const today = runWindow(id, istDateKey(now)).entryAtMs;
        return { id, nextEntryAt: today >= now ? today : runWindow(id, istDateKey(now + DAY)).entryAtMs };
      }),
    });
  }

  /** Live view for the API: open runs with current marks, computed from the latest chain. */
  async livePositions() {
    const chain = await this.getChain(10_000);
    const now = Date.now();
    return [...this.open.values()].map((run) => {
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
  }
}

export const botEngine = new BotEngine();
