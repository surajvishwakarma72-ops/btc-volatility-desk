import { randomUUID } from 'node:crypto';
import type { AlgoStrategy } from '../../lib/algo/rule.js';
import { istDateKey } from '../../lib/bot/schedule.js';
import { deltaKeyStatus } from '../delta-keys.js';
import { paperFor } from '../paper/paper-terminal.js';
import { getWatchConfig } from '../watch/watch-store.js';
import { atmIvOf, buildPlan, conditionsOf, needsHist, pulseSlotOf, describePlan, runName, summariseWhy, type EntryPlan } from './algo-engine.js';
import { evalConditions } from '../../lib/algo/conditions.js';
import { createRun, type RunRow } from './algo-store.js';
import { paperBroker } from './brokers.js';
import { killAllLive, liveBroker } from './live-entry.js';
import { loadMarket } from './algo-runtime.js';
import { loadInsights } from './insights-service.js';
import { speedVsIv } from '../../lib/algo/conditions.js';
import { compareToAtm, decayToExitUsd, estimateProfit, thetaPerDayUsd, type ProfitEstimate } from '../../lib/algo/profit.js';
import { defaultStrangle, entryState, exitAtMs, windowOn, type EntryWindow } from '../../lib/algo/rule.js';
import { buildMarketReport, type MarketReport } from '../../lib/algo/market-report.js';
import { describeEvents } from '../../lib/algo/event-path.js';
import { eventsForTrade } from './event-guard.js';
import { planOptionEntry } from '../../lib/algo/plan.js';
import { deltaSignedGet } from '../../routes/delta.js';
import { loadDeltaKey } from '../delta-keys.js';
import { DESK_USER_ID } from '../auth-store.js';

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
  legs: Array<{ symbol: string; side: 'buy' | 'sell'; lots: number; strike: number; type: 'call' | 'put'; expiryCode: string; price: number; delta: number; gamma: number | null; theta: number | null; iv: number | null; gammaPctOfAtm: number | null; ivVsAtm: number | null; thetaPerDayUsd: number | null }>;
  atm: { iv: number | null; gamma: number | null } | null;
  /** Estimated profit from time decay until the exit. Options only. */
  profit: ProfitEstimate | null;
  margin: { required: number | null; availableAfter: number | null; available: number | null; note: string } | null;
  /** Live trades: what the real Delta wallet holds (null on Paper or when it cannot be read). */
  wallet: Wallet | null;
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
  // a live entry is skipped when a US news release falls between now and the planned exit: say so before it is placed
  if (rule.mode === 'live') {
    const evs = await eventsForTrade(rule, plan).catch(() => null);
    if (evs && evs.length) { bad++; reasons.push(`A news event is in the path of this trade: ${describeEvents(evs)}. A live entry would be skipped.`); }
    else if (evs === null) reasons.push('The news calendar could not be read, so events were not checked.');
    else reasons.push('No US news event between now and the planned exit.');
  }
  return { verdict: bad ? 'wait' : 'go', headline: bad ? 'Better to wait' : 'Conditions are acceptable for selling', reasons, suggest: { stopMultiple: 2, note: 'A 2x stop on each sold leg, with everything closing when one stops.' } };
}

/** Everything the trade summary shows, without placing anything. */
export interface Wallet { assets: Array<{ symbol: string; balance: number; available: number }>; note: string }
const walletCache = new Map<string, { at: number; v: Wallet | null }>();
/** The real Delta wallet, read with the user's own key. Cached for a few seconds so editing a summary does not hammer the exchange. */
export async function fetchWallet(userId: string): Promise<Wallet | null> {
  const hit = walletCache.get(userId);
  if (hit && Date.now() - hit.at < 15_000) return hit.v;
  const creds = (await loadDeltaKey(userId, 'trade')) ?? (await loadDeltaKey(userId, 'read')) ?? (userId === DESK_USER_ID && process.env.DELTA_API_KEY && process.env.DELTA_API_SECRET ? { key: process.env.DELTA_API_KEY, secret: process.env.DELTA_API_SECRET } : null);
  let v: Wallet | null = null;
  if (creds) {
    try {
      const r = await deltaSignedGet(creds.key, creds.secret, '/v2/wallet/balances', '');
      if (r.ok) {
        const list = (((r.body as { result?: unknown[] })?.result ?? []) as Array<Record<string, unknown>>);
        const assets = list.map((a) => ({ symbol: String(a.asset_symbol ?? a.symbol ?? (a.asset as { symbol?: string } | undefined)?.symbol ?? '?'), balance: Number(a.balance ?? 0), available: Number(a.available_balance ?? a.available ?? a.balance ?? 0) })).filter((a) => Number.isFinite(a.available) && (a.available > 0 || a.balance > 0));
        v = { assets, note: 'your Delta wallet, read with your key' };
      }
    } catch { v = null; }
  }
  walletCache.set(userId, { at: Date.now(), v });
  return v;
}

/** When the trade would start: now for a trade placed now, otherwise the next time the entry window opens. */
function startOf(rule: AlgoStrategy, when: 'now' | 'later', now: number): { startMs: number; window: EntryWindow } {
  if (when === 'now') return { startMs: now, window: { dateKey: istDateKey(now), startMs: now, endMs: now } };
  const es = entryState(rule, now);
  if (es.state !== 'closed') return { startMs: es.window.startMs <= now ? now : es.window.startMs, window: es.window };
  const w = windowOn(rule.entry, istDateKey(now + 86_400_000));
  return { startMs: w.startMs, window: w };
}

export async function previewEntry(userId: string, rule: AlgoStrategy, lots: number, when: 'now' | 'later' = 'now'): Promise<Preview> {
  const now = Date.now();
  const conds = conditionsOf(rule);
  const m = await loadMarket(true, needsHist(conds), pulseSlotOf(rule, conds)); // candles are always loaded so the recommendation can read speed vs IV
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
      margin = { required: pv.marginRequired ?? null, availableAfter: pv.availableAfter ?? null, available: pv.availableAfter != null && pv.marginRequired != null ? pv.availableAfter + pv.marginRequired : null, note: 'estimated with the desk portfolio margin model on your Paper account' };
    } catch { margin = null; }
  }
  // greeks of each leg against the at-the-money strike of the same expiry, time decay until the exit, and what the account has
  let atm: Preview['atm'] = null, profit: ProfitEstimate | null = null;
  const legExtras = new Map<string, { gamma: number | null; theta: number | null; iv: number | null; gammaPctOfAtm: number | null; ivVsAtm: number | null; thetaPerDayUsd: number | null }>();
  if (plan?.kind === 'option') {
    const expiryMs = plan.legs[0]?.expiryMs;
    const row = expiryMs ? m.chain.filter((o) => o.expiryMs === expiryMs) : [];
    if (row.length) {
      const k = row.reduce((b, o) => (Math.abs(o.strike - m.spot) < Math.abs(b - m.spot) ? o.strike : b), row[0]!.strike);
      const at = row.filter((o) => o.strike === k), avg = (xs: Array<number | undefined>) => { const v = xs.filter((x): x is number => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      atm = { iv: avg(at.map((o) => o.iv)), gamma: avg(at.map((o) => o.gamma)) };
    }
    for (const l of plan.legs) {
      const c = atm ? compareToAtm(l, atm) : { gammaPctOfAtm: null, ivVsAtm: null };
      legExtras.set(l.symbol + l.side, { gamma: l.gamma ?? null, theta: l.theta ?? null, iv: l.iv ?? null, gammaPctOfAtm: c.gammaPctOfAtm, ivVsAtm: c.ivVsAtm, thetaPerDayUsd: thetaPerDayUsd([l]) });
    }
    const { startMs, window } = startOf(rule, when, now);
    const exitMs = exitAtMs(rule.exit, window, startMs);
    const stopAt = Math.min(...plan.legs.map((l) => l.expiryMs ?? Infinity));
    const endMs = exitMs != null ? Math.min(exitMs, stopAt) : stopAt;
    const hrs = (endMs - startMs) / 3_600_000;
    profit = Number.isFinite(endMs) ? estimateProfit(plan.legs, hrs, plan.premium, decayToExitUsd(plan.legs, m.spot, hrs, startMs)) : null;
  }
  const wallet = rule.mode === 'live' ? await fetchWallet(userId).catch(() => null) : null;
  return {
    ok: !!plan, reason, spot: m.spot, stops, atm, profit, wallet,
    lines: plan ? describePlan(plan) : [],
    expiries: plan?.kind === 'option' ? plan.expiries : [],
    premium: plan?.kind === 'option' ? plan.premium : null,
    legs: plan?.kind === 'option' ? plan.legs.map((l) => ({ symbol: l.symbol, side: l.side, lots: l.lots, strike: l.strike, type: l.type, expiryCode: l.expiryCode, price: l.side === 'sell' ? l.bid : l.ask, delta: l.delta, ...(legExtras.get(l.symbol + l.side) ?? { gamma: null, theta: null, iv: null, gammaPctOfAtm: null, ivVsAtm: null, thetaPerDayUsd: null }) })) : [],
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let reportCache: { at: number; v: MarketReport } | null = null;

/**
 * "Market condition" in Ask me: the whole market read for a short strangle seller. Built from the same live candles, option chain,
 * IV history and desk gate the entry conditions use. Cached for 20 s so a few people asking at once cost one read.
 */
export async function marketReport(): Promise<MarketReport> {
  const now = Date.now();
  if (reportCache && now - reportCache.at < 20_000) return reportCache.v;
  const m = await loadMarket(true, true);
  const rule = defaultStrangle();
  const exps = m.expiries.filter((e) => e - now > 2 * 3_600_000).sort((a, b) => a - b);
  const e = exps[0];
  let atm: Parameters<typeof buildMarketReport>[0]['atm'] = null;
  if (e != null) {
    const row = m.chain.filter((o) => o.expiryMs === e);
    if (row.length) {
      const k = row.reduce((b, o) => (Math.abs(o.strike - m.spot) < Math.abs(b - m.spot) ? o.strike : b), row[0]!.strike);
      const at = row.filter((o) => o.strike === k), avg = (xs: Array<number | undefined>) => { const v = xs.filter((x): x is number => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      const call = at.find((o) => o.type === 'call'), put = at.find((o) => o.type === 'put'), d = new Date(e);
      atm = { expiryLabel: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, hoursLeft: (e - now) / 3_600_000, strike: k, iv: avg(at.map((o) => o.iv)), gamma: avg(at.map((o) => o.gamma)), theta: avg(at.map((o) => o.theta)), straddle: call && put ? call.mark + put.mark : null };
    }
  }
  const p = planOptionEntry(rule, m.chain, m.expiries, m.spot, 1, now);
  const legs = p.ok ? p.legs.filter((l) => l.side === 'sell').map((l) => ({ type: l.type, strike: l.strike, delta: l.delta, gamma: l.gamma ?? null, iv: l.iv ?? null, price: l.bid })) : null;
  const v = buildMarketReport({ nowMs: now, spot: m.spot, bars5m: m.bars5m, atmIv: atmIvOf(rule, m, now), dvol: m.dvol, gateGo: m.gateGo, gateReasons: m.gateReasons, hist: m.hist, clock: m.clock, atm, legs });
  reportCache = { at: now, v };
  return v;
}

/** Close everything: open paper strategies, loose paper positions, and (only if a trade key exists) real option positions. */
export type ExitScope = 'paper' | 'live' | 'both';

/** scope: 'paper' closes only the paper side, 'live' closes the real Delta positions at market and cancels every pending order, 'both' is the older all-in-one exit. */
export async function exitAll(userId: string, scope: ExitScope = 'both'): Promise<{ scope: ExitScope; paperClosed: number; paperPositions: number; live: { sent: boolean; message: string; cancelled?: number } | null }> {
  if (scope === 'live') {
    const live = await killAllLive(userId, { market: true, cancelPending: true }).catch((e: Error) => ({ sent: false, message: `Could not reach Delta (${e.message}). Close the real positions and cancel the orders on Delta yourself.` }));
    return { scope, paperClosed: 0, paperPositions: 0, live };
  }
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
  let live: { sent: boolean; message: string; cancelled?: number } | null = null;
  if (scope === 'both' && (await deltaKeyStatus(userId, 'trade')).connected) {
    // the paper side is already closed; a Delta problem must be reported, not hide that
    live = await killAllLive(userId).catch((e: Error) => ({ sent: false, message: `Could not reach Delta (${e.message}). Close the real positions on Delta yourself.` }));
  }
  return { scope, paperClosed, paperPositions, live };
}
