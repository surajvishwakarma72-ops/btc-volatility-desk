/** Order-book walking, slippage and fee math. Pure; fee rates always come from the caller (products API). */

export type BookLevel = readonly [price: number, size: number];

export interface Fill {
  /** Volume-weighted average price over the filled size. */
  avgPrice: number;
  filled: number;
  /** True when the book had less size than requested. */
  partial: boolean;
  /** Signed slippage vs the best level, in price units (always <= 0 for the trader). */
  slippage: number;
}

/**
 * Walk one side of the book for `lots`. Buying walks the asks (ascending), selling walks the
 * bids (descending); the caller passes the correct side already sorted best-first.
 */
export function walkBook(levels: readonly BookLevel[], lots: number, side: 'buy' | 'sell', extraTicks = 0, tick = 0): Fill {
  let remaining = lots;
  let cost = 0;
  let filled = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(size, remaining);
    cost += take * price;
    filled += take;
    remaining -= take;
  }
  if (filled === 0) return { avgPrice: NaN, filled: 0, partial: true, slippage: 0 };
  const best = levels[0]![0];
  const pad = extraTicks * tick * (side === 'buy' ? 1 : -1);
  const avgPrice = cost / filled + pad;
  const slippage = side === 'buy' ? best - avgPrice : avgPrice - best;
  return { avgPrice, filled, partial: remaining > 0, slippage };
}

export interface OptionFeeInput {
  price: number;
  lots: number;
  contractValue: number;
  spot: number;
  /** Fee as a fraction of underlying notional (taker_commission_rate or maker). */
  rate: number;
  /** Fee cap as a fraction of premium (premium_commission_rate). */
  premiumCapRate: number;
  /** GST on fees, 0.18 on Indian platforms. */
  gst?: number;
}

/** Options fee: the lower of rate x underlying notional and cap x premium, plus GST. */
export function optionFee(i: OptionFeeInput): number {
  const gst = i.gst ?? 0.18;
  const notional = i.spot * i.lots * i.contractValue;
  const premium = i.price * i.lots * i.contractValue;
  const base = Math.min(i.rate * notional, i.premiumCapRate * premium);
  return base * (1 + gst);
}

export interface FuturesFeeInput {
  price: number;
  lots: number;
  contractValue: number;
  rate: number;
  gst?: number;
}

export function futuresFee(i: FuturesFeeInput): number {
  const gst = i.gst ?? 0.18;
  return i.rate * i.price * i.lots * i.contractValue * (1 + gst);
}

/** Skip a futures trade whose round-trip fee eats too much of the risked amount. */
export function feeToRiskOk(roundTripFeeUsd: number, riskUsd: number, maxFraction = 0.35): boolean {
  return riskUsd > 0 && roundTripFeeUsd / riskUsd <= maxFraction;
}
