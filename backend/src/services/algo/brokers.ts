import { paperFor } from '../paper/paper-terminal.js';
import type { AlgoStrategy } from '../../lib/algo/rule.js';
import type { Broker, BrokerStatus, EntryPlan, PlaceResult } from './algo-engine.js';

/**
 * The paper broker: places the plan as ONE basket on the user's own Paper Trade account (best bid / ask fills, margin checked,
 * per-leg stops, the stop alarm and hard exit already watch it) and reads it back as a strategy.
 */
const PERP = 'BTCUSD';
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The price at which a futures stop of `futStopUsd` dollars (or, for older rules, a percent) is hit. One lot is 0.001 BTC, so $1 of price move is lots x 0.001 dollars. */
export function futureStopPrice(exit: AlgoStrategy['exit'], side: 'long' | 'short', spot: number, lots: number): number | null {
  if (exit.futStopUsd != null) {
    const move = exit.futStopUsd / (lots * 0.001);
    return round1(side === 'long' ? spot - move : spot + move);
  }
  const pct = exit.futStopPct;
  return pct == null ? null : round1(side === 'long' ? spot * (1 - pct / 100) : spot * (1 + pct / 100));
}

export const paperBroker: Broker = {
  async place(userId: string, rule: AlgoStrategy, plan: EntryPlan, name: string): Promise<PlaceResult> {
    const t = paperFor(userId);
    if (plan.kind === 'future') {
      const { side, lots, spot } = plan.future;
      const stop = futureStopPrice(rule.exit, side, spot, lots);
      const r = await t.placeBasket([{ symbol: PERP, side: side === 'long' ? 'buy' : 'sell', lots, stop }], name);
      return r.ok ? { ok: true, ref: (r as { basketId: string }).basketId, detail: `${side} ${lots} lots BTC perpetual` } : { ok: false, reason: r.reason ?? 'the paper account refused the order' };
    }
    const mult = rule.exit.legStopMultiple;
    const legs = plan.legs.map((l) => ({
      symbol: l.symbol, side: l.side, lots: l.lots,
      // a sold option's stop is a multiple of what it can be sold at; 2x is the account's own default; a bought option has no stop
      ...(l.side === 'sell' ? (mult == null ? { stop: null } : mult === 2 ? {} : { stop: round1(l.bid * mult) }) : { stop: null }),
    }));
    const r = await t.placeBasket(legs, name);
    return r.ok ? { ok: true, ref: (r as { basketId: string }).basketId, detail: `${legs.length} legs` } : { ok: false, reason: r.reason ?? 'the paper account refused the order' };
  },

  async status(userId: string, ref: string): Promise<BrokerStatus | null> {
    let s;
    try { s = await paperFor(userId).strategies(40); } catch { return null; }
    const open = s.open.find((x) => x.id === ref);
    const hit = open ?? s.closed.find((x) => x.id === ref);
    if (!hit) return { open: false, netPnl: null, closedReason: 'the strategy is no longer on the Paper page' };
    const leg = hit.legs[0];
    const fut = leg && /^BTCUSD$/.test(leg.symbol) && leg.mark != null ? { entry: leg.entry, mark: leg.mark, side: leg.side === 'buy' ? 'long' as const : 'short' as const } : undefined;
    const legs = hit.legs.map((l) => ({ symbol: l.symbol, side: l.side === 'buy' ? 'buy' as const : 'sell' as const, lots: l.lots, entry: l.entry, mark: l.exit ?? l.mark, pnl: l.pnl }));
    return { open: !!open, netPnl: hit.netPnl, legs, closedReason: open ? null : (hit.closeReason ?? 'closed'), future: open ? fut : undefined };
  },

  async closeAll(userId: string, ref: string, reason: string) {
    const r = await paperFor(userId).closeStrategy(ref, reason);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  },
};
