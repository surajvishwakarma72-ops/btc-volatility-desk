import { evalConditions, type ConditionResult, type MarketView } from '../../lib/algo/conditions.js';
import { chooseExpiries, describeLeg, planOptionEntry, type PlannedLeg } from '../../lib/algo/plan.js';
import { entryState, exitAtMs, istDay, windowOn, type AlgoStrategy, type Condition, type EntryWindow } from '../../lib/algo/rule.js';
import type { Bar } from '../../lib/bot/futures.js';
import type { ClockIv, Sample } from '../../lib/algo/series-math.js';
import type { ChainOption } from '../../lib/bot/strike-picker.js';
import { istDateKey } from '../../lib/bot/schedule.js';
import { createRun, finishRun, getRun, listArmed, openRuns, type RunRow, type StrategyRow } from './algo-store.js';

/**
 * The Algo engine. Every 5 seconds, for each ARMED strategy it:
 *   1. waits for the entry window (a hard time, or a window like 22:30-01:30) on a selected day,
 *   2. checks every condition the user wrote, over and over, and enters ONCE when all pass,
 *   3. hands the order to a broker (paper account or the locked live path),
 *   4. watches the open run: net target, net stop, exit time, and a position that was closed by its own stops.
 * A strategy trades at most once per window (a unique run row per strategy and day), and a failed entry is not retried that day.
 */
export interface MarketData {
  spot: number;
  chain: ChainOption[];
  expiries: number[];
  dvol: number | null;
  gateGo: boolean | null;
  gateReasons: string[];
  bars5m: Bar[];
  hist?: Sample[];
  clock?: ClockIv | null;
}

export interface FuturePlan { side: 'long' | 'short'; lots: number; spot: number }
export type EntryPlan = { kind: 'option'; legs: PlannedLeg[]; expiries: string[]; spot: number; premium: number } | { kind: 'future'; future: FuturePlan };

export type PlaceResult = { ok: true; ref: string; dry?: boolean; detail: string } | { ok: false; reason: string };
export interface LegStatus { symbol: string; side: 'buy' | 'sell'; lots: number; entry: number; mark: number | null; pnl: number | null }
export interface BrokerStatus { open: boolean; netPnl: number | null; /** some contracts of this run are gone while others remain (a leg's stop fired) */ legGone?: boolean; /** each leg's own PnL, before fees */ legs?: LegStatus[]; closedReason?: string | null; /** futures: entry, mark and side of the one position */ future?: { entry: number; mark: number; side: 'long' | 'short' } }

export interface Broker {
  place(userId: string, rule: AlgoStrategy, plan: EntryPlan, name: string): Promise<PlaceResult>;
  status(userId: string, ref: string): Promise<BrokerStatus | null>;
  closeAll(userId: string, ref: string, reason: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface AlgoDeps {
  now(): number;
  armed(): Promise<StrategyRow[]>;
  openRuns(): Promise<RunRow[]>;
  getRun(strategyId: string, dateKey: string): Promise<RunRow | null>;
  createRun: typeof createRun;
  finishRun: typeof finishRun;
  /** Disarm a strategy (a one-time strategy after its attempt, or one whose valid-until time has passed). */
  disarm?(userId: string, strategyId: string): Promise<void>;
  /** Record the run's net PnL for the minute chart (optional so tests need not provide it). */
  mark?(runId: string, tMs: number, net: number, spot: number | null): Promise<void>;
  market(needBars: boolean, needHist?: boolean): Promise<MarketData>;
  broker(mode: 'paper' | 'live'): Broker;
}

export interface CheckInfo {
  at: number;
  state: 'waiting' | 'entered' | 'before' | 'closed' | 'expired';
  met: boolean;
  results: ConditionResult[];
  planReason: string | null;
  windowStart: number | null;
  windowEnd: number | null;
}

export const needsBars = (cs: readonly Condition[]) => cs.some((c) => ['rsi', 'adx', 'ema', 'speed', 'macd', 'bb', 'atr', 'vwap', 'change', 'adx_falling', 'rsi_falling', 'rv_falling', 'edge'].includes(c.type));
export const needsHist = (cs: readonly Condition[]) => cs.some((c) => ['atmiv_falling', 'dvol_falling', 'ivclock'].includes(c.type));
export const conditionsOf = (r: AlgoStrategy): Condition[] => (r.entry.kind === 'window' ? r.entry.conditions : []);

/** ATM IV (vol points) of the first expiry the rule trades: the average of the call and put nearest spot. */
export function atmIvOf(rule: AlgoStrategy, m: MarketData, nowMs: number): number | null {
  const ex = chooseExpiries(rule.expiry, m.expiries, nowMs);
  const e = typeof ex === 'string' ? m.expiries.filter((x) => x - nowMs > 0).sort((a, b) => a - b)[0] : ex[0];
  if (e == null) return null;
  const row = m.chain.filter((o) => o.expiryMs === e && o.iv > 0 && Number.isFinite(o.iv));
  if (!row.length) return null;
  const k = row.reduce((b, o) => (Math.abs(o.strike - m.spot) < Math.abs(b - m.spot) ? o.strike : b), row[0]!.strike);
  const ivs = row.filter((o) => o.strike === k).map((o) => o.iv);
  return ivs.reduce((a, b) => a + b, 0) / ivs.length;
}

/** Build the concrete plan and the view the conditions look at. */
export function buildPlan(rule: AlgoStrategy, m: MarketData, lots: number, nowMs: number): { plan: EntryPlan | null; reason: string | null; view: MarketView } {
  const base: MarketView = { spot: m.spot, dvol: m.dvol, gateGo: m.gateGo, gateReasons: m.gateReasons, premium: null, bars5m: m.bars5m, atmIv: atmIvOf(rule, m, nowMs), hist: m.hist, clock: m.clock, nowMs };
  if (rule.instrument === 'future') return { plan: { kind: 'future', future: { side: rule.future!.side, lots: rule.future!.lots ?? lots, spot: m.spot } }, reason: null, view: base };
  const p = planOptionEntry(rule, m.chain, m.expiries, m.spot, lots, nowMs);
  if (!p.ok) return { plan: null, reason: p.reason, view: base };
  return { plan: { kind: 'option', legs: p.legs, expiries: p.expiries, spot: p.spot, premium: p.premium }, reason: null, view: { ...base, premium: p.premium } };
}

/** A short readable name for the run: "Short strangle 271026+281026". */
export function runName(rule: AlgoStrategy, plan: EntryPlan): string {
  return plan.kind === 'option' ? `${rule.name} ${plan.expiries.join('+')}` : `${rule.name} ${plan.future.side}`;
}

export function summariseWhy(rule: AlgoStrategy, results: readonly ConditionResult[], window: EntryWindow | null): string {
  const when = rule.entry.kind === 'hard' ? `hard entry at ${rule.entry.time} IST` : `window ${rule.entry.from}-${rule.entry.to} IST`;
  const why = results.length ? results.map((r) => `${r.label} (${r.now})`).join('; ') : 'no extra conditions';
  void window;
  return `${when}; ${why}`;
}

export class AlgoEngine {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** The latest look at each strategy, for the panel. In memory only: it is rebuilt on every tick. */
  readonly checks = new Map<string, CheckInfo>();
  /** The latest problem per user. One shared field would show one user's strategy names to another. */
  readonly errors = new Map<string, string>();

  constructor(private readonly d: AlgoDeps) {}

  start(everyMs = 5_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, everyMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const armed = await this.d.armed();
      for (const s of armed) {
        try { await this.entryStep(s); this.errors.delete(s.userId); } catch (e) { this.errors.set(s.userId, `${s.rule.name}: ${(e as Error).message}`); }
      }
      for (const r of await this.d.openRuns()) {
        try { await this.exitStep(r); } catch (e) { this.errors.set(r.userId, `${r.name}: ${(e as Error).message}`); }
      }
    } finally {
      this.busy = false;
    }
  }

  private async entryStep(s: StrategyRow): Promise<void> {
    const d = this.d, now = d.now(), rule = s.rule;
    // the valid-until time: past it the strategy cancels itself
    if (rule.validUntil != null && now >= rule.validUntil) {
      await d.createRun({ userId: s.userId, strategyId: s.id, name: rule.name, dateKey: `cancel-${rule.validUntil}`, mode: rule.mode, status: 'skipped', lots: 0, reason: 'Cancelled: its valid-until time passed, so it was disarmed.', plan: null, ref: null, windowStart: rule.validUntil, enteredAt: null, exitAt: null });
      await d.disarm?.(s.userId, s.id);
      this.checks.set(s.id, { at: now, state: 'expired', met: false, results: [], planReason: null, windowStart: null, windowEnd: null });
      return;
    }
    const es = entryState(rule, now);
    if (es.state !== 'open') {
      this.checks.set(s.id, { at: now, state: es.state, met: false, results: [], planReason: null, windowStart: es.state === 'before' ? es.window.startMs : null, windowEnd: es.state === 'before' ? es.window.endMs : null });
      await this.skipEnded(s, now);
      return;
    }
    const w = es.window;
    if (await d.getRun(s.id, w.dateKey)) {
      this.checks.set(s.id, { at: now, state: 'entered', met: true, results: [], planReason: null, windowStart: w.startMs, windowEnd: w.endMs });
      return;
    }
    const conds = conditionsOf(rule);
    const m = await d.market(needsBars(conds), needsHist(conds));
    const { plan, reason, view } = buildPlan(rule, m, s.lots, now);
    const ev = evalConditions(conds, view);
    this.checks.set(s.id, { at: now, state: 'waiting', met: ev.met && !!plan, results: ev.results, planReason: reason, windowStart: w.startMs, windowEnd: w.endMs });
    if (!ev.met || !plan) {
      this.lastWaiting.set(s.id, [...ev.results.filter((r) => !r.ok).map((r) => `${r.label} (${r.now})`), ...(reason ? [reason] : [])].join('; ') || 'waiting');
      return;
    }

    const why = summariseWhy(rule, ev.results, w);
    const name = runName(rule, plan);
    const placed = await d.broker(rule.mode).place(s.userId, rule, plan, name);
    const base = { userId: s.userId, strategyId: s.id, name, dateKey: w.dateKey, mode: rule.mode, lots: plan.kind === 'option' ? Math.max(...plan.legs.map((l) => l.lots)) : plan.future.lots, plan: { rule, plan, why, conds: ev.results.map((x) => ({ label: x.label, ok: x.ok })) }, windowStart: w.startMs, enteredAt: now, exitAt: null as number | null };
    if (!placed.ok) {
      await d.createRun({ ...base, status: 'failed', reason: placed.reason, ref: null, enteredAt: null });
      await this.finishOnce(s);
      return;
    }
    if (placed.dry) {
      await d.createRun({ ...base, status: 'dry', reason: placed.detail, ref: placed.ref, enteredAt: null });
      await this.finishOnce(s);
      return;
    }
    await d.createRun({ ...base, status: 'entered', reason: why, ref: placed.ref, exitAt: exitAtMs(rule.exit, w, now) });
    await this.finishOnce(s);
  }

  /** A one-time strategy disarms itself after its one attempt, whatever came of it. */
  private async finishOnce(s: StrategyRow): Promise<void> {
    if (s.rule.repeat === 'once') await this.d.disarm?.(s.userId, s.id);
  }

  /** A window that ended without an entry is written down once, with what stopped it. */
  private async skipEnded(s: StrategyRow, now: number): Promise<void> {
    for (const key of [istDateKey(now), istDateKey(now - 86_400_000)]) {
      const w = windowOn(s.rule.entry, key);
      if (now < w.endMs || now - w.endMs > 6 * 3_600_000) continue;
      if (!s.rule.days.includes(istDay(w.startMs))) continue;
      if (s.updatedAt > w.endMs) continue; // armed after the window: nothing was missed
      if (await this.d.getRun(s.id, key)) continue;
      const prev = this.lastWaiting.get(s.id);
      await this.d.createRun({
        userId: s.userId, strategyId: s.id, name: s.rule.name, dateKey: key, mode: s.rule.mode, status: 'skipped', lots: 0,
        reason: prev ? `window ended without an entry. Last check: ${prev}` : 'window ended without an entry (the engine did not see the window open)',
        plan: null, ref: null, windowStart: w.startMs, enteredAt: null, exitAt: null,
      });
      await this.finishOnce(s);
    }
  }
  private lastWaiting = new Map<string, string>();
  /** run id -> consecutive ticks a sold leg has been at or past its stop price */
  private legBreach = new Map<string, number>();

  private async exitStep(r: RunRow): Promise<void> {
    const d = this.d, now = d.now();
    const rule = (r.plan as { rule?: AlgoStrategy } | null)?.rule;
    if (!rule || !r.ref) { await d.finishRun(r.id, 'failed', 'the run lost its rule or reference, close the position yourself', null); return; }
    const broker = d.broker(r.mode);
    const st = await broker.status(r.userId, r.ref);
    if (!st) return; // the account could not be read this time; try again next tick
    if (st.netPnl != null && d.mark) await d.mark(r.id, now, st.netPnl, st.future?.mark ?? null).catch(() => undefined);
    if (!st.open) { await d.finishRun(r.id, 'exited', st.closedReason ?? 'the position is closed', st.netPnl); return; }
    const x = rule.exit;
    let why: string | null = null;
    // the desk's own per-leg stop on a Live run, so the stop holds even if Delta took no stop order. The price is the book's mid, which a thin
    // book can spike for a moment, so the breach must hold on two ticks in a row (about 10 s) before every leg is closed. Worked out here,
    // outside the chain below, so that a run with no breach still reaches the exit-time and futures checks.
    let legHit: LegStatus | undefined;
    if (rule.mode === 'live' && x.legStopMultiple && x.exitAllOnLegStop) {
      legHit = (st.legs ?? []).find((l) => l.side === 'sell' && l.entry > 0 && l.mark != null && l.mark >= l.entry * x.legStopMultiple!);
      const n = legHit ? (this.legBreach.get(r.id) ?? 0) + 1 : 0;
      if (n) this.legBreach.set(r.id, n); else this.legBreach.delete(r.id);
      if (n < 2) legHit = undefined;
    }
    if (x.netTargetUsd != null && st.netPnl != null && st.netPnl >= x.netTargetUsd) why = `net target reached (${st.netPnl.toFixed(2)} >= ${x.netTargetUsd})`;
    else if (x.netStopUsd != null && st.netPnl != null && st.netPnl <= -x.netStopUsd) why = `net stop reached (${st.netPnl.toFixed(2)} <= -${x.netStopUsd})`;
    else if (st.legGone && x.exitAllOnLegStop) why = 'a leg was stopped out, closing the rest';
    else if (legHit) why = `${legHit.symbol} reached its ${x.legStopMultiple}x stop (${legHit.mark} >= ${(legHit.entry * x.legStopMultiple!).toFixed(2)}), closing every leg`;
    else if (r.exitAt != null && now >= r.exitAt) why = `exit time ${x.exitTime} IST`;
    else if (st.future) {
      const { entry, mark, side } = st.future;
      const move = ((side === 'long' ? mark - entry : entry - mark) / entry) * 100;
      // dollars of profit or loss on the position: one lot is 0.001 BTC
      const usdMove = (side === 'long' ? mark - entry : entry - mark) * r.lots * 0.001;
      if (x.futTargetUsd != null && usdMove >= x.futTargetUsd) why = `futures target $${x.futTargetUsd} reached (${usdMove.toFixed(2)})`;
      else if (x.futStopUsd != null && usdMove <= -x.futStopUsd) why = `futures stop $${x.futStopUsd} reached (${usdMove.toFixed(2)})`;
      else if (x.futTargetPct != null && move >= x.futTargetPct) why = `futures target ${x.futTargetPct}% reached`;
      else if (x.futStopPct != null && move <= -x.futStopPct) why = `futures stop ${x.futStopPct}% reached`;
    }
    if (!why) return;
    const closed = await broker.closeAll(r.userId, r.ref, why);
    if (closed.ok) await d.finishRun(r.id, 'exited', why, st.netPnl);
    else this.errors.set(r.userId, `${r.name}: could not close (${closed.reason}); will retry`);
  }
}

/** The text for the trade summary and the confirmation message. */
export function describePlan(plan: EntryPlan): string[] {
  return plan.kind === 'option' ? plan.legs.map(describeLeg) : [`${plan.future.side === 'long' ? 'Buy' : 'Sell'} ${plan.future.lots} lots BTC perpetual near ${plan.future.spot.toFixed(0)}`];
}

export { listArmed, openRuns, getRun };
