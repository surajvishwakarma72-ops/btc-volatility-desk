import type { OptionType } from './types.js';

/** One quoted option from the live chain (or a replayed chain). */
export interface ChainOption {
  symbol: string;
  type: OptionType;
  strike: number;
  expiryMs: number;
  /** Absolute delta, 0..1. */
  delta: number;
  bid: number;
  ask: number;
  mark: number;
  iv: number;
}

export interface DeltaBand {
  low: number;
  high: number;
  target: number;
}

export const SHORT_BAND: DeltaBand = { low: 0.1, high: 0.15, target: 0.125 };

/**
 * Pick the short body leg of the requested type: inside the band, closest to the target delta.
 * Falls back to the nearest strike just below the band (desk rule) if none sits inside it.
 * Quotes with no bid are skipped: a sold leg must be fillable.
 */
export function pickBodyLeg(chain: readonly ChainOption[], type: OptionType, expiryMs: number, band: DeltaBand = SHORT_BAND): ChainOption | null {
  const side = chain.filter((o) => o.type === type && o.expiryMs === expiryMs && o.bid > 0);
  const inBand = side.filter((o) => o.delta >= band.low && o.delta <= band.high);
  if (inBand.length) {
    return inBand.reduce((best, o) => (Math.abs(o.delta - band.target) < Math.abs(best.delta - band.target) ? o : best));
  }
  const below = side.filter((o) => o.delta < band.low);
  return below.length ? below.reduce((best, o) => (o.delta > best.delta ? o : best)) : null;
}

/**
 * Bought wing for an iron condor: further OTM than the body, closest to `wingDelta`.
 * Wings must have an ask (we are buying them).
 */
export function pickWing(chain: readonly ChainOption[], body: ChainOption, wingDelta = 0.04): ChainOption | null {
  const farther = chain.filter(
    (o) =>
      o.type === body.type &&
      o.expiryMs === body.expiryMs &&
      o.ask > 0 &&
      (body.type === 'call' ? o.strike > body.strike : o.strike < body.strike),
  );
  if (!farther.length) return null;
  return farther.reduce((best, o) => (Math.abs(o.delta - wingDelta) < Math.abs(best.delta - wingDelta) ? o : best));
}

/** ATM straddle: the strike nearest spot that has both a call and a put with an ask. */
export function pickAtmStraddle(
  chain: readonly ChainOption[],
  expiryMs: number,
  spot: number,
): { call: ChainOption; put: ChainOption } | null {
  const strikes = new Set(chain.filter((o) => o.expiryMs === expiryMs).map((o) => o.strike));
  const ordered = [...strikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
  for (const k of ordered) {
    const call = chain.find((o) => o.expiryMs === expiryMs && o.strike === k && o.type === 'call' && o.ask > 0);
    const put = chain.find((o) => o.expiryMs === expiryMs && o.strike === k && o.type === 'put' && o.ask > 0);
    if (call && put) return { call, put };
  }
  return null;
}
