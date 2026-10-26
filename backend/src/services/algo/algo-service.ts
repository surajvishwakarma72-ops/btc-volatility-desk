import { randomUUID } from 'node:crypto';
import type { AlgoStrategy } from '../../lib/algo/rule.js';
import { istDateKey } from '../../lib/bot/schedule.js';
import { deltaKeyStatus } from '../delta-keys.js';
import { paperFor } from '../paper/paper-terminal.js';
import { getWatchConfig } from '../watch/watch-store.js';
import { atmIvOf, buildPlan, conditionsOf, describePlan, runName, summariseWhy, type EntryPlan } from './algo-engine.js';
import { evalConditions } from '../../lib/algo/conditions.js';
import { createRun, type RunRow } from './algo-store.js';
import { paperBroker } from './brokers.js';
import { killAllLive, liveBroker } from './live-entry.js';
import { loadMarket } from './algo-runtime.js';
import { loadInsights } from './insights-service.js';
import { speedVsIv } from '../../lib/algo/conditions.js';

/**
 * What the Algo routes and the Ask-me trading commands share: a preview of an entry, an immediate entry, exit-all, the unlock
 * state of live trading, and adopting a position that is already open.
 */
export interface LiveState {
  /** A trading-permission key is saved. Live strategies and Ask-me real orders need it. */
  tradeKey: boolean;
  keyLast4: string | null;
  armed: boolean;
  dryRun: boolean;
  /** The server owner enabled real orders (LIVE_TRADING_ENABLED). */
  serverEnabled: boolean;
  /** Real orders would actually go out right now. */
  canSendReal: boolean;
}

export async function liveState(userId: string): Promise<LiveState> {
  const [k, cfg] = await Promise.all([deltaKeyStatus(userId, 'trade'), getWatchConfig(userId, 0)]);
  const serverEnabled = process.env.LIVE_TRADING_ENABLED === 'true';
  return { tradeKey: !!k.connected, keyLast4: (k as { keyLast4?: string | null }).keyLast4 ?? null, armed: cfg.liveArmed, dryRun: cfg.dryRun, serverEnabled, canSendReal: !!k.connected && cfg.liveArmed && !cfg.dryRun && serverEnabled };
}

export interface Preview {
  ok: boolean;
  reason: string | null;
  lines: string[];
  expiries: string[];
  premium: number | null;
  spot: number;
  legs: Array<{ symbol: string; side: 'buy' | 'sell'; lots: number; strike: number; type: 'call' | 'put'; expiryCode: string; price: number; delta: number }>;
  margin: { required: number | null; availableAfter: number | null; note: string } | null;
  stops: string;
  conditions: Array<{ label: string; ok: boolean; now: string }>;
  conditionsMet: boolean;
  recommend: Recommendation | null;
  plan: EntryPlan | null;
}

export interface Recommendation {
  verdict: 'go' | 'wait';
  headline: string;
  reasons: string[];
  /** What it suggests for the order itself. Futures: dollar stop and target and a side. Options: the stop multiple. */
  suggest: { side?: 'long' | 'short'; stopUsd?: number; targetUsd?: number; stopMultiple?: number; note: string };
}

/**
 * The auto recommendation shown with the summary. Rule based: the desk gate, DVOL, ATM IV, speed vs IV, and what the best
 * recent indicator says right now. It is a read of the conditions, not a forecast.
 */
export async function recommend(rule: AlgoStrategy, lots: number, m: Awaited<ReturnType<typeof loadMarket>>, plan: EntryPlan | null): Promise<Recommendation> {
  const reasons: string[] = [];
  let bad = 0;
  if (m.gateGo === false) { bad++; reasons.push(`The desk gate says WAIT (${m.gateReasons.join('; ') || 'not clear'}).`); }
  else if (m.gateGo) reasons.push('The desk gate says GO.');
  if (m.dvol != null) reasons.push(`DVOL is ${m.dvol.toFixed(1)}.`);
  let ins: Awaited<ReturnType<typeof loadInsights>> | null = null;
  try { ins = await loadInsights(); } catch { ins = null; }
  const notional = lots * 0.001 * m.spot;
  if (rule.instrument === 'future') {
    const top = ins?.futures.find((f) => f.score > 1 && f.now !== 0) ?? null;
    const side: 'long' | 'short' = rule.future?.side ?? 'long';
    const stopUsd = Math.max(1, Math.round(notional * 0.005)), targetUsd = stopUsd * 2;
    if (top) {
      const dir = top.now === 1 ? 'long' : 'short';
      reasons.push(`The best recent futures indicator (${top.label}) points ${dir} now: it was right ${(top.winRate * 100).toFixed(0)}% of the time over 4 hours in the last 4 weeks.`);
      if (dir !== side) { bad++; reasons.push(`That is against the ${side} you chose.`); }
    } else reasons.push('No recent indicator is giving a clear signal right now.');
    const sp = speedVsIv(m.bars5m, atmIvOf(rule, m, Date.now()), 60);
    if (sp != null) reasons.push(`Price moved ${sp.toFixed(2)}x what the ATM IV implies over the last hour.`);
    return { verdict: bad ? 'wait' : 'go', headline: bad ? 'Better to wait or reconsider' : 'Conditions are acceptable', reasons, suggest: { side: top ? (top.now === 1 ? 'long' : 'short') : side, stopUsd, targetUsd, note: `Suggested stop $${stopUsd} and target $${targetUsd} (0.5% and 1% of the $${notional.toFixed(0)} position, a 1:2 risk to reward).` } };
  }
  const sp = speedVsIv(m.bars5m, atmIvOf(rule, m, Date.now()), 60);
  if (sp != null) { reasons.push(`Price moved ${sp.toFixed(2)}x what the ATM IV implies over the last hour.`); if (sp > 1.5) { bad++; reasons.push('That is fast for a seller: wait for it to calm down.'); } }
  const calm = ins?.options.filter((o) => o.now && o.calmerPct > 5).slice(0, 2) ?? [];
  if (calm.length) reasons.push(`Calm signs that held up recently and are true now: ${calm.map((c) => c.label).join('; ')}.`);
  else if (ins?.options.length) reasons.push('None of the recent calm signs is true right now.');
  void plan;
  return { verdict: bad ? 'wait' : 'go', headline: bad ? 'Better to wait' : 'Conditions are acceptable for selling', reasons, suggest: { stopMultiple: 2, note: 'A 2x stop on each sold leg, with everything closing when one stops.' } };
}

/** Everything the trade summary shows, without placing anything. */
export async function previewEntry(userId: string, rule: AlgoStrategy, lots: number): Promise<Preview> {
  const now = Date.now();
  const conds = conditionsOf(rule);
  const m = await loadMarket(true); // candles are always loaded so the recommendation can read speed vs IV
  const { plan, reason, view } = buildPlan(rule, m, lots, now);
  const ev = evalConditions(conds, view);
  const mult = rule.exit.legStopMultiple;
  const stops = plan?.kind === 'future'
    ? `${rule.exit.futStopPct != null ? `stop ${rule.exit.futStopPct}%` : 'no stop'}${rule.exit.futTargetPct != null ? `, target ${rule.exit.futTargetPct}%` : ''}`
    : mult == null ? 'no per-leg stop' : `each sold leg stops at ${mult}x its sell price${rule.exit.exitAllOnLegStop ? ', and the whole trade closes when one stops' : ''}`;
  let margin: Preview['margin'] = null;
  if (plan) {
    try {
      const legs = plan.kind === 'option'
        ? plan.legs.map((l) => ({ symbol: l.symbol, side: l.side, lots: l.lots }))
        : [{ symbol: 'BTCUSD', side: plan.future.side === 'long' ? 'buy' as const : 'sell' as const, lots: plan.future.lots }];
      const pv = await paperFor(userId).previewBasket(legs) as { ok: boolean; marginRequired?: number; availableAfter?: number };
      margin = { required: pv.marginRequired ?? null, availableAfter: pv.availableAfter ?? null, note: 'estimated with the desk portfolio margin model on your Paper account' };
    } catch { margin = null; }
  }
  return {
    ok: !!plan, reason, spot: m.spot, stops,
    lines: plan ? describePlan(plan) : [],
    expiries: plan?.kind === 'option' ? plan.expiries : [],
    premium: plan?.kind === 'option' ? plan.premium : null,
    legs: plan?.kind === 'option' ? plan.legs.map((l) => ({ symbol: l.symbol, side: l.side, lots: l.lots, strike: l.strike, type: l.type, expiryCode: l.expiryCode, price: l.side === 'sell' ? l.bid : l.ask, delta: l.delta })) : [],
    margin, conditions: ev.results, conditionsMet: ev.met, recommend: await recommend(rule, lots, m, plan).catch(() => null), plan,
  };
}

export type EnterResult = { ok: true; run: RunRow | null; dry: boolean; detail: string; plan: EntryPlan; why: string } | { ok: false; reason: string };

/** Enter right now (an Ask-me "ok", or the panel's Enter now), ignoring the window, and track it as a run. */
export async function enterNow(userId: string, rule: AlgoStrategy, lots: number, strategyId: string | null = null): Promise<EnterResult> {
  const m = await loadMarket(false);
  const { plan, reason } = buildPlan(rule, m, lots, Date.now());
  if (!plan) return { ok: false, reason: reason ?? 'could not build the trade' };
  const name = runName(rule, plan);
  const broker = rule.mode === 'live' ? liveBroker : paperBroker;
  const placed = await broker.place(userId, rule, plan, name);
  const why = `manual entry now; ${summariseWhy(rule, [], null)}`;
  if (!placed.ok) return { ok: false, reason: placed.reason };
  const now = Date.now();
  const w = istDateKey(now);
  const run = await createRun({
    userId, strategyId, name, dateKey: strategyId ? `${w}#manual-${randomUUID().slice(0, 6)}` : `manual-${randomUUID()}`, mode: rule.mode,
    status: placed.dry ? 'dry' : 'entered', lots: plan.kind === 'option' ? Math.max(...plan.legs.map((l) => l.lots)) : plan.future.lots,
    reason: placed.dry ? placed.detail : why, plan: { rule, plan, why }, ref: placed.ref, windowStart: now, enteredAt: placed.dry ? null : now, exitAt: null,
  });
  return { ok: true, run, dry: !!placed.dry, detail: placed.detail, plan, why };
}

/** Close everything: open paper strategies, loose paper positions, and (only if a trade key exists) real option positions. */
export async function exitAll(userId: string): Promise<{ paperClosed: number; paperPositions: number; live: { sent: boolean; message: string } | null }> {
  const t = paperFor(userId);
  const strategies = await t.strategies(0);
  let paperClosed = 0;
  for (const s of strategies.open) {
    const r = await t.closeStrategy(s.id, 'Exit all');
    if (r.ok) paperClosed++;
  }
  await t.cancelAll();
  let paperPositions = 0;
  const acc = await t.account();
  for (const p of acc.positions) {
    if (!p.lots) continue;
    await t.place({ symbol: p.symbol, side: p.lots > 0 ? 'sell' : 'buy', type: 'market', lots: Math.abs(p.lots), reduceOnly: true });
    paperPositions++;
  }
  let live: { sent: boolean; message: string } | null = null;
  if ((await deltaKeyStatus(userId, 'trade')).connected) {
    // the paper side is already closed; a Delta problem must be reported, not hide that
    live = await killAllLive(userId).catch((e: Error) => ({ sent: false, message: `Could not reach Delta (${e.message}). Close the real positions on Delta yourself.` }));
  }
  return { paperClosed, paperPositions, live };
}
