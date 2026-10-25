import { futuresFee, optionFee, type BookLevel } from './costs.js';
import { portfolioMargin, type MarginPosition } from './portfolio-margin.js';

/**
 * Pure core of the Paper Trade terminal: a Delta-style account the user trades by hand with fake money
 * against the REAL Delta order books. Nothing here does I/O; the service feeds it live books and quotes.
 *
 * Accounting follows how Delta behaves:
 *  - options are cash-settled premium trades: buying pays the premium out of cash, selling credits it;
 *    the open position is worth lots x contract value x mark;
 *  - the BTC perpetual only moves cash through realised PnL and fees (linear USD approximation);
 *  - margin is the perpetual's notional / leverage plus a portfolio margin on all options together;
 *  - equity = cash + options value + perpetual unrealised PnL; available = equity - margin.
 */
export type Kind = 'option' | 'perp';
export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop_market';

export interface Instrument {
  symbol: string;
  kind: Kind;
  contractValue: number;
  takerRate: number;
  makerRate: number;
  premiumCapRate: number;
  tick: number;
  maxLeverage: number;
  option?: { type: 'call' | 'put'; strike: number; expiryMs: number; iv: number };
}

export interface Quote {
  bid: number;
  ask: number;
  mark: number;
}

export interface Position {
  symbol: string;
  /** Signed lots: positive long, negative short. */
  lots: number;
  avgEntry: number;
  leverage: number;
  /** Realised PnL on this symbol since it was first opened (before fees). */
  realized: number;
}

export interface OrderReq {
  symbol: string;
  side: Side;
  type: OrderType;
  lots: number;
  price?: number;
  stopPrice?: number;
  reduceOnly?: boolean;
  leverage?: number;
}

const EPS = 1e-9;
export const MAINTENANCE_FRACTION = 0.5;

export const signed = (side: Side, lots: number): number => (side === 'buy' ? lots : -lots);

export const roundToTick = (price: number, tick: number): number => (tick > 0 ? Math.round(price / tick) * tick : price);

// ---------- validation ----------

export function validateOrder(o: OrderReq, inst: Instrument, pos: Position | null): string | null {
  if (!Number.isInteger(o.lots) || o.lots < 1) return 'lots must be a whole number of at least 1';
  if (o.lots > 1_000_000) return 'lots is unrealistically large';
  if (o.type === 'limit' && !(o.price != null && o.price > 0)) return 'a limit order needs a positive price';
  if (o.type === 'stop_market' && !(o.stopPrice != null && o.stopPrice > 0)) return 'a stop order needs a positive stop price';
  if (o.leverage != null) {
    if (inst.kind !== 'perp') return 'leverage applies to the perpetual only (options are bought for cash or margined as a portfolio)';
    if (!Number.isFinite(o.leverage) || o.leverage < 1 || o.leverage > inst.maxLeverage) return `leverage must be between 1 and ${inst.maxLeverage}`;
  }
  if (o.reduceOnly) {
    if (!pos || pos.lots === 0) return 'reduce-only order, but there is no open position in this contract';
    const closes = (pos.lots > 0 && o.side === 'sell') || (pos.lots < 0 && o.side === 'buy');
    if (!closes) return 'reduce-only order would increase the position';
  }
  return null;
}

// ---------- fills ----------

export interface Walk {
  filled: number;
  avgPrice: number;
  /** Price of the best level on the side taken, for slippage. */
  best: number;
}

/**
 * Take liquidity from one side of the book (asks for a buy, bids for a sell), optionally stopping at a limit
 * price. Returns what actually fills; the caller decides what to do with the rest.
 */
export function walk(levels: readonly BookLevel[], side: Side, lots: number, limit?: number): Walk {
  let remaining = lots;
  let cost = 0;
  let filled = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    if (limit != null && (side === 'buy' ? price > limit + EPS : price < limit - EPS)) break;
    const take = Math.min(size, remaining);
    cost += take * price;
    filled += take;
    remaining -= take;
  }
  return { filled, avgPrice: filled ? cost / filled : NaN, best: levels[0]?.[0] ?? NaN };
}

export function feeFor(inst: Instrument, price: number, lots: number, spot: number, maker: boolean): number {
  const rate = maker ? inst.makerRate : inst.takerRate;
  if (inst.kind === 'option') {
    return optionFee({ price, lots, contractValue: inst.contractValue, spot, rate, premiumCapRate: inst.premiumCapRate });
  }
  return futuresFee({ price, lots, contractValue: inst.contractValue, rate });
}

// ---------- positions ----------

/** Net a trade into a position. Returns the new position (null when flat) and the PnL realised by any part that closed. */
export function applyTrade(pos: Position | null, delta: number, price: number, cv: number, leverage: number, symbol: string): { pos: Position | null; realized: number } {
  if (!pos || pos.lots === 0) {
    return { pos: delta === 0 ? null : { symbol, lots: delta, avgEntry: price, leverage, realized: pos?.realized ?? 0 }, realized: 0 };
  }
  const sameWay = Math.sign(pos.lots) === Math.sign(delta);
  if (sameWay) {
    const total = pos.lots + delta;
    return { pos: { ...pos, lots: total, avgEntry: (pos.avgEntry * Math.abs(pos.lots) + price * Math.abs(delta)) / Math.abs(total), leverage }, realized: 0 };
  }
  const closing = Math.min(Math.abs(delta), Math.abs(pos.lots));
  const realized = closing * cv * (price - pos.avgEntry) * Math.sign(pos.lots);
  const left = pos.lots + delta;
  const base = { ...pos, realized: pos.realized + realized, leverage };
  if (left === 0) return { pos: { ...base, lots: 0 }, realized };
  if (Math.sign(left) === Math.sign(pos.lots)) return { pos: { ...base, lots: left }, realized };
  return { pos: { ...base, lots: left, avgEntry: price }, realized };
}

export const unrealized = (pos: Position, mark: number, cv: number): number => pos.lots * cv * (mark - pos.avgEntry);

// ---------- account ----------

export interface Account {
  cash: number;
  startBalance: number;
}

export interface Marks {
  spot: number;
  nowMs: number;
  quote: (symbol: string) => Quote | undefined;
}

export interface AccountView {
  cash: number;
  /** Mark-to-market value of open option positions (long positive, short negative). */
  optionsValue: number;
  perpUnrealized: number;
  equity: number;
  perpMargin: number;
  optionMargin: number;
  margin: number;
  available: number;
  /** Equity as a multiple of the margin in use (null when nothing is open). */
  marginRatio: number | null;
}

/**
 * How option margin is worked out, as on Delta's own margin-mode switch:
 *  - portfolio: one margin for all options together from stress scenarios, so spreads, condors and hedged
 *    positions need far less than their legs would alone;
 *  - standard: every short option is margined on its own (premium plus a share of the underlying), with no
 *    credit for the other legs. Delta does not publish its standard formula; this follows the common
 *    exchange form (mark + max(15% of spot - out-of-the-money amount, 10% of spot)).
 */
export type MarginMode = 'portfolio' | 'standard';

export function standardOptionMargin(shorts: ReadonlyArray<{ type: 'call' | 'put'; strike: number; lots: number; mark: number }>, spot: number, cv: number): number {
  let total = 0;
  for (const s of shorts) {
    const otm = s.type === 'call' ? Math.max(s.strike - spot, 0) : Math.max(spot - s.strike, 0);
    total += s.lots * cv * (s.mark + Math.max(0.15 * spot - otm, 0.1 * spot));
  }
  return total;
}

export function accountView(acct: Account, positions: readonly Position[], insts: ReadonlyMap<string, Instrument>, m: Marks, mode: MarginMode = 'portfolio'): AccountView {
  let optionsValue = 0;
  let perpUnrealized = 0;
  let perpMargin = 0;
  let futLots = 0;
  const optPos: MarginPosition[] = [];
  const shorts: Array<{ type: 'call' | 'put'; strike: number; lots: number; mark: number }> = [];
  for (const p of positions) {
    if (p.lots === 0) continue;
    const inst = insts.get(p.symbol);
    const q = m.quote(p.symbol);
    if (!inst || !q) continue;
    const mark = q.mark > 0 ? q.mark : (q.bid + q.ask) / 2;
    if (inst.kind === 'option') {
      optionsValue += p.lots * inst.contractValue * mark;
      optPos.push({
        type: inst.option!.type, side: p.lots > 0 ? 'long' : 'short', strike: inst.option!.strike, expiryMs: inst.option!.expiryMs,
        lots: Math.abs(p.lots), iv: inst.option!.iv > 0 ? inst.option!.iv : 40,
      });
      if (p.lots < 0) shorts.push({ type: inst.option!.type, strike: inst.option!.strike, lots: -p.lots, mark });
    } else {
      perpUnrealized += unrealized(p, mark, inst.contractValue);
      if (mode === 'standard') perpMargin += (Math.abs(p.lots) * inst.contractValue * mark) / Math.max(p.leverage, 1);
      else futLots += p.lots;
    }
  }
  // portfolio mode: the futures are stressed together with the options (no per-position leverage), as on Delta
  const optionMargin = !optPos.length ? 0 : mode === 'standard' ? standardOptionMargin(shorts, m.spot, 0.001) : portfolioMargin(optPos, m.spot, m.nowMs, 0.001).margin;
  if (mode === 'portfolio' && futLots !== 0) perpMargin = portfolioMargin(optPos, m.spot, m.nowMs, 0.001, futLots).margin - optionMargin;
  const equity = acct.cash + optionsValue + perpUnrealized;
  const margin = perpMargin + optionMargin;
  return {
    cash: acct.cash, optionsValue, perpUnrealized, equity, perpMargin, optionMargin, margin,
    available: equity - margin, marginRatio: margin > 0 ? equity / margin : null,
  };
}

/** The account is liquidated when equity falls below the maintenance share of the margin in use. */
export const shouldLiquidate = (v: AccountView): boolean => v.margin > 0 && v.equity < v.margin * MAINTENANCE_FRACTION;

/** Cash effect of a fill: options pay or receive the premium, the perpetual only pays the fee (PnL arrives when it closes). */
export function cashDelta(inst: Instrument, side: Side, lots: number, price: number, fee: number, realizedPerp: number): number {
  if (inst.kind === 'option') return (side === 'sell' ? 1 : -1) * price * lots * inst.contractValue - fee;
  return realizedPerp - fee;
}

// ---------- resting orders ----------

/** A buy stop triggers when the mark rises to the stop, a sell stop when it falls to it. */
export function stopTriggered(side: Side, stopPrice: number, mark: number): boolean {
  return side === 'buy' ? mark >= stopPrice - EPS : mark <= stopPrice + EPS;
}

/**
 * A resting limit order fills (as maker, at its own price) only when the market trades STRICTLY through it:
 * a buy needs the best ask below the limit, a sell the best bid above it. Merely touching it is not enough,
 * because in the real book other orders at that price would be ahead of ours in the queue.
 */
export function limitTradesThrough(side: Side, limit: number, q: Pick<Quote, 'bid' | 'ask'>): boolean {
  return side === 'buy' ? q.ask > 0 && q.ask < limit - EPS : q.bid > 0 && q.bid > limit + EPS;
}

// ---------- expiry ----------

/** Cash-settlement price of an expired option at the index price: its intrinsic value. */
export function intrinsicAtExpiry(type: 'call' | 'put', strike: number, spot: number): number {
  return Math.max(type === 'call' ? spot - strike : strike - spot, 0);
}

// ---------- strategy payoff at expiry ----------

export interface PayoffLeg {
  type: 'call' | 'put';
  strike: number;
  side: Side;
  lots: number;
  /** Price paid (buy) or received (sell), USD per 1 BTC. */
  price: number;
  contractValue: number;
}

export interface PayoffSummary {
  /** [spot at expiry, profit or loss in USD before fees], for drawing the chart. */
  points: Array<[number, number]>;
  /** null means unlimited. */
  maxProfit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  /** Net premium: positive is a credit received, negative a debit paid. */
  netPremium: number;
}

export function pnlAtExpiry(legs: readonly PayoffLeg[], spot: number): number {
  let total = 0;
  for (const l of legs) {
    const intrinsic = Math.max(l.type === 'call' ? spot - l.strike : l.strike - spot, 0);
    const dir = l.side === 'buy' ? 1 : -1;
    total += dir * (intrinsic - l.price) * l.lots * l.contractValue;
  }
  return total;
}

export function payoffSummary(legs: readonly PayoffLeg[], spot: number): PayoffSummary {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const lo = Math.min(spot * 0.6, strikes[0] ?? spot);
  const hi = Math.max(spot * 1.4, strikes[strikes.length - 1] ?? spot);
  const xs = new Set<number>([0, lo, hi, ...strikes]);
  for (let i = 0; i <= 160; i++) xs.add(lo + ((hi - lo) * i) / 160);
  const grid = [...xs].sort((a, b) => a - b);
  const points = grid.filter((x) => x >= lo).map((x) => [x, pnlAtExpiry(legs, x)] as [number, number]);
  const upSlope = legs.reduce((s, l) => s + (l.type === 'call' ? (l.side === 'buy' ? 1 : -1) * l.lots * l.contractValue : 0), 0);
  const kinks = [0, ...strikes].map((x) => pnlAtExpiry(legs, x));
  const best = Math.max(...kinks);
  const worst = Math.min(...kinks);
  const netPremium = legs.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.price * l.lots * l.contractValue, 0);
  // breakevens: sign changes between kinks (the payoff is a straight line between them), plus one beyond the top strike
  const bx: number[] = [];
  const knots = [0, ...strikes];
  for (let i = 0; i + 1 < knots.length; i++) {
    const a = pnlAtExpiry(legs, knots[i]!);
    const b = pnlAtExpiry(legs, knots[i + 1]!);
    if (a === 0 && i === 0) continue;
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) bx.push(knots[i]! + ((knots[i + 1]! - knots[i]!) * -a) / (b - a));
    else if (b === 0 && i + 1 < knots.length - 1) bx.push(knots[i + 1]!);
  }
  const top = knots[knots.length - 1]!;
  const pTop = pnlAtExpiry(legs, top);
  if (upSlope !== 0 && Math.sign(pTop) !== Math.sign(upSlope) && pTop !== 0) bx.push(top - pTop / upSlope);
  return {
    points,
    maxProfit: upSlope > 1e-12 ? null : best,
    maxLoss: upSlope < -1e-12 ? null : worst,
    breakevens: [...new Set(bx.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b),
    netPremium,
  };
}
