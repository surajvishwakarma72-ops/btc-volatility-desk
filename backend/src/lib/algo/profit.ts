/**
 * Estimated profit until the exit, from time decay alone, plus the greek comparisons the summary shows for each leg.
 * Pure arithmetic over numbers the Delta chain already gives (theta per day, gamma, IV); no forecast of BTC or IV.
 */
export interface GreekLeg {
  side: 'buy' | 'sell';
  lots: number;
  theta?: number | null;
  gamma?: number | null;
  iv?: number | null;
}

/** One lot is 0.001 BTC and Delta quotes option prices and theta per 1 BTC. */
const LOT = 0.001;

/** What the position earns each day from time decay if BTC and IV stay where they are (negative when you are long and paying it). */
export function thetaPerDayUsd(legs: readonly GreekLeg[]): number | null {
  let total = 0;
  for (const l of legs) {
    if (l.theta == null || !Number.isFinite(l.theta)) return null;
    total += (l.side === 'sell' ? -1 : 1) * l.theta * l.lots * LOT;
  }
  return total;
}

export interface ProfitEstimate {
  perDayUsd: number;
  /** Time decay from entry to the exit (or to expiry when there is no exit time). */
  toExitUsd: number;
  /** The most a short structure can make: the premium it collects, when everything expires worthless. */
  maxUsd: number | null;
  hoursToExit: number;
  note: string;
}

export function estimateProfit(legs: readonly GreekLeg[], hoursToExit: number | null, premium: number | null): ProfitEstimate | null {
  const perDay = thetaPerDayUsd(legs);
  if (perDay == null || hoursToExit == null || !(hoursToExit > 0)) return null;
  return {
    perDayUsd: perDay,
    toExitUsd: perDay * (hoursToExit / 24),
    maxUsd: premium != null && premium > 0 ? premium : null,
    hoursToExit,
    note: 'Time decay only, before fees, if BTC and IV stay where they are. Decay speeds up near expiry, so a long hold earns a little more than this, and a big move can wipe it out.',
  };
}

export interface LegCompare {
  gammaPctOfAtm: number | null;
  ivVsAtm: number | null;
}

/** A leg's gamma as a share of the at-the-money gamma (small means a gentler leg), and its IV against the at-the-money IV (the skew you are selling). */
export function compareToAtm(leg: GreekLeg, atm: { gamma: number | null; iv: number | null }): LegCompare {
  return {
    gammaPctOfAtm: leg.gamma != null && atm.gamma ? (leg.gamma / atm.gamma) * 100 : null,
    ivVsAtm: leg.iv != null && atm.iv != null ? leg.iv - atm.iv : null,
  };
}

/** Lots for an INR capital at the desk's rule of thumb: 100 INR of capital per lot (10,000 gives 100 lots, 5,000 gives 50). */
export function lotsForCapital(inr: number): number {
  return Math.max(1, Math.floor(inr / 100));
}
