import { optionFee, walkBook } from '../../lib/bot/costs.js';
import type { Leg } from '../../lib/bot/types.js';
import type { Book, FeeRates } from './delta-public.js';

export interface PlannedLeg {
  symbol: string;
  type: 'call' | 'put';
  side: 'long' | 'short';
  strike: number;
  expiryMs: number;
  lots: number;
  role: Leg['role'];
  /** Quote at decision time (the "intended" price for slippage accounting). */
  intendedPrice: number;
}

export interface LegFill {
  symbol: string;
  action: 'entry' | 'exit';
  side: 'buy' | 'sell';
  lots: number;
  intendedPrice: number;
  avgPrice: number;
  filled: number;
  partial: boolean;
  fee: number;
}

export interface BrokerResult {
  ok: boolean;
  reason?: string;
  fills: LegFill[];
  fees: number;
}

/**
 * Simulated broker: fills against the real L2 book at the moment of the order, as a market order does on Delta:
 * sells hit the best bid, buys lift the best ask, and only a size larger than the top level goes deeper. No extra tick
 * is added to the price. Delta's real fee rates apply. A leg must fill completely, since
 * a half-built strangle is not the strategy being tested.
 */
export function paperExecute(
  legs: PlannedLeg[],
  action: 'entry' | 'exit',
  books: Map<string, Book>,
  rates: Map<string, FeeRates>,
  spot: number,
  extraTicks = 0,
  tick = 0.5,
): BrokerResult {
  const fills: LegFill[] = [];
  let fees = 0;
  for (const leg of legs) {
    // Entry: shorts sell, longs buy. Exit reverses.
    const sells = action === 'entry' ? leg.side === 'short' : leg.side === 'long';
    const book = books.get(leg.symbol);
    if (!book) return { ok: false, reason: `no order book for ${leg.symbol}`, fills, fees };
    const levels = sells ? book.bids : book.asks;
    const w = walkBook(levels, leg.lots, sells ? 'sell' : 'buy', extraTicks, tick);
    if (w.filled < leg.lots) {
      return { ok: false, reason: `${leg.symbol}: book fills ${w.filled}/${leg.lots} lots`, fills, fees };
    }
    const r = rates.get(leg.symbol);
    const fee = r
      ? optionFee({ price: w.avgPrice, lots: leg.lots, contractValue: r.contractValue, spot, rate: r.takerRate, premiumCapRate: r.premiumCapRate })
      : 0;
    fees += fee;
    fills.push({
      symbol: leg.symbol,
      action,
      side: sells ? 'sell' : 'buy',
      lots: leg.lots,
      intendedPrice: leg.intendedPrice,
      avgPrice: w.avgPrice,
      filled: w.filled,
      partial: w.partial,
      fee,
    });
  }
  return { ok: true, fills, fees };
}
