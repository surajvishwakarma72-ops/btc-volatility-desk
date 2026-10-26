import { pickAtmStraddle, pickBodyLeg, type ChainOption } from '../bot/strike-picker.js';
import type { AlgoStrategy, OptionLegRule } from './rule.js';

/** One order leg the planner wants placed, on the paper basket's own vocabulary (buy / sell). */
export interface PlannedLeg {
  symbol: string;
  side: 'buy' | 'sell';
  lots: number;
  /** Quote at planning time, for the summary and for the premium test. */
  bid: number;
  ask: number;
  delta: number;
  strike: number;
  expiryCode: string;
  type: 'call' | 'put';
}

export type PlanResult = { ok: true; legs: PlannedLeg[]; expiries: string[]; spot: number; premium: number; notes: string[] } | { ok: false; reason: string };

/** DDMMYY of an expiry instant (Delta settles daily options at 12:00 UTC). */
export function expiryCodeOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}${p(d.getUTCMonth() + 1)}${String(d.getUTCFullYear()).slice(2)}`;
}

/** Expiries the rule asks for: skips any that settle within `minAheadMs` (too close to trade). */
export function chooseExpiries(rule: AlgoStrategy['expiry'], expiries: readonly number[], nowMs: number, minAheadMs = 60 * 60_000): number[] | string {
  const live = [...expiries].filter((e) => e - nowMs >= minAheadMs).sort((a, b) => a - b);
  if (rule.mode === 'fixed') {
    const hit = live.find((e) => expiryCodeOf(e) === rule.code);
    return hit ? [hit] : `expiry ${rule.code} is not listed (or settles within the hour)`;
  }
  if (!live.length) return 'no expiry is listed';
  if (rule.mode === 'current' || rule.mode === 'nearest') return [live[0]!];
  if (rule.mode === 'next') return live.length > 1 ? [live[1]!] : 'there is no 1DTE (next) expiry listed';
  if (rule.mode === 'n2n') return live.length > 2 ? [live[2]!] : 'there is no 2DTE (next to next) expiry listed';
  return live.length > 1 ? [live[0]!, live[1]!] : [live[0]!]; // b2b (older rules): the first two together
}

function pickLeg(rule: OptionLegRule, chain: readonly ChainOption[], expiryMs: number, spot: number): ChainOption | string {
  const side = rule.side === 'sell' ? 'bid' : 'ask';
  const usable = (o: ChainOption) => o.type === rule.type && o.expiryMs === expiryMs && o[side] > 0;
  const p = rule.pick;
  if (p.mode === 'delta' && p.target != null) {
    // the strike whose delta is nearest the target
    const t = p.target;
    const best = chain.filter(usable).reduce<ChainOption | null>((b, o) => (b == null || Math.abs(o.delta - t) < Math.abs(b.delta - t) ? o : b), null);
    // never settle for a strike far from the ask: a 0.02-delta option is not "nearest 0.10" in any useful sense
    if (!best) return `no ${rule.type} is quoted with a ${side}`;
    return Math.abs(best.delta - t) <= 0.05 ? best : `the closest ${rule.type} to delta ${t} has delta ${best.delta.toFixed(2)}, too far away`;
  }
  if (p.mode === 'delta') {
    const lowB = p.low ?? 0.1, highB = p.high ?? 0.15;
    // older rules: the lowest delta inside the band
    const hit = rule.side === 'sell'
      ? pickBodyLeg(chain, rule.type, expiryMs, { low: lowB, high: highB, target: lowB })
      : chain.filter((o) => usable(o) && o.delta >= lowB && o.delta <= highB).sort((a, b) => a.delta - b.delta)[0] ?? null;
    return hit ?? `no ${rule.type} with delta ${lowB}-${highB} and a ${side} is quoted`;
  }
  const cand = chain.filter(usable);
  if (!cand.length) return `no ${rule.type} is quoted with a ${side}`;
  const nearest = (target: number) => cand.reduce((b, o) => (Math.abs(o.strike - target) < Math.abs(b.strike - target) ? o : b));
  if (p.mode === 'strike') return nearest(p.strike);
  if (p.mode === 'atm') return nearest(spot);
  return nearest(rule.type === 'call' ? spot + p.points : spot - p.points);
}

/**
 * Turn an option rule into the concrete legs to trade right now. `lots` is the entry command's size (the number in
 * "entry 50"); a leg that carries its own lots keeps them. Back-to-back expiry trades the whole structure in each expiry.
 */
export function planOptionEntry(rule: AlgoStrategy, chain: readonly ChainOption[], expiries: readonly number[], spot: number, lots: number, nowMs: number): PlanResult {
  if (rule.instrument !== 'option') return { ok: false, reason: 'this is not an option strategy' };
  const chosen = chooseExpiries(rule.expiry, expiries, nowMs);
  if (typeof chosen === 'string') return { ok: false, reason: chosen };
  const legs: PlannedLeg[] = [];
  const notes: string[] = [];
  for (const ex of chosen) {
    const code = expiryCodeOf(ex);
    // a straddle written as two atm legs must land on the same strike, so price them together
    const atmPair = rule.legs.length === 2 && rule.legs.every((l) => l.pick.mode === 'atm') && new Set(rule.legs.map((l) => l.type)).size === 2;
    const straddle = atmPair ? pickAtmStraddle(chain, ex, spot) : null;
    for (const l of rule.legs) {
      const o = atmPair && straddle ? (l.type === 'call' ? straddle.call : straddle.put) : pickLeg(l, chain, ex, spot);
      if (typeof o === 'string') return { ok: false, reason: `${code}: ${o}` };
      legs.push({ symbol: o.symbol, side: l.side, lots: l.lots ?? lots, bid: o.bid, ask: o.ask, delta: o.delta, strike: o.strike, expiryCode: code, type: l.type });
    }
    if (chosen.length > 1) notes.push(`${code}: ${rule.legs.length} legs`);
  }
  const seen = new Set<string>();
  for (const l of legs) {
    const k = `${l.symbol}|${l.side}`;
    if (seen.has(k)) return { ok: false, reason: `the rule picks ${l.symbol} twice; widen the delta band or use different strikes` };
    seen.add(k);
  }
  // premium collected by the sold legs, at the bid, in USD (one lot = 0.001 BTC)
  const premium = legs.reduce((s, l) => s + (l.side === 'sell' ? l.bid * l.lots * 0.001 : -l.ask * l.lots * 0.001), 0);
  return { ok: true, legs, expiries: chosen.map(expiryCodeOf), spot, premium, notes };
}

/** One readable line per leg for the trade summary. */
export function describeLeg(l: PlannedLeg): string {
  return `${l.side === 'sell' ? 'Sell' : 'Buy'} ${l.lots} x ${l.strike} ${l.type === 'call' ? 'Call' : 'Put'} (${l.expiryCode}) at ${(l.side === 'sell' ? l.bid : l.ask).toFixed(1)}, delta ${l.delta.toFixed(2)}`;
}
