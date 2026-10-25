/** Futures position sizing: fixed risk per trade, lots follow the stop distance. */

export interface FuturesSizeInput {
  riskUsd: number;
  /** Distance from entry to stop, in USD of price. */
  stopDistance: number;
  /** Underlying per lot (0.001 BTC), so one lot gains/loses contractValue USD per 1 USD move. */
  contractValue: number;
  maxLots: number;
}

export interface FuturesSize {
  lots: number;
  /** Actual loss if stopped (<= riskUsd because lots are whole). */
  riskAtStopUsd: number;
}

/** Wider stops get fewer lots so the loss at the stop stays the configured risk. */
export function futuresLots(i: FuturesSizeInput): FuturesSize | null {
  if (!(i.stopDistance > 0) || !(i.riskUsd > 0) || !(i.contractValue > 0)) return null;
  const raw = Math.floor(i.riskUsd / (i.stopDistance * i.contractValue));
  const lots = Math.min(raw, i.maxLots);
  if (lots < 1) return null;
  return { lots, riskAtStopUsd: lots * i.stopDistance * i.contractValue };
}

/**
 * Highest leverage (<= maxLeverage) that keeps the stop inside `maxFractionOfLiq` of the way to
 * liquidation. Liquidation distance is approximated as entry / leverage for isolated margin.
 * Returns null when even 1x cannot satisfy the guard (stop is wider than the guard allows).
 */
export function chooseLeverage(
  entry: number,
  stopDistance: number,
  maxLeverage: number,
  maxFractionOfLiq = 0.4,
): number | null {
  if (!(entry > 0) || !(stopDistance > 0)) return null;
  const ceiling = Math.floor((maxFractionOfLiq * entry) / stopDistance);
  const lev = Math.min(maxLeverage, ceiling);
  return lev >= 1 ? lev : null;
}
