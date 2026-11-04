/**
 * Estimated profit until the exit, from time decay alone, plus the greek comparisons the summary shows for each leg.
 * Pure arithmetic over numbers the Delta chain already gives (theta per day, gamma, IV); no forecast of BTC or IV.
 */
import { bs } from '../../backtest/lib/pricing.js';

export interface GreekLeg {
  side: 'buy' | 'sell';
  lots: number;
  theta?: number | null;
  gamma?: number | null;
  iv?: number | null;
  strike?: number | null;
  type?: 'call' | 'put';
  expiryMs?: number | null;
  contractValue?: number | null;
  asset?: string | null;
  symbol?: string | null;
}

export const ASSET_LOT_SIZES: Readonly<Record<string, number>> = {
  BTC: 0.001,
  ETH: 0.01,
  XAUT: 0.001,
};

export const DEFAULT_LOT = 0.001;
const YEAR_MS = 365 * 86_400_000;

/**
 * Resolves the real contract lot size for a leg.
 * Explicit contractValue takes precedence; otherwise uses verified asset lot sizes.
 * If an asset is explicitly unknown, refuses to guess and returns null.
 */
export function resolveLotSize(leg: GreekLeg): number | null {
  if (leg.contractValue != null && Number.isFinite(leg.contractValue) && leg.contractValue > 0) {
    return leg.contractValue;
  }
  const asset = (leg.asset || (leg.symbol ? leg.symbol.split('-')[1] : null) || '').trim().toUpperCase();
  if (asset) {
    const known = ASSET_LOT_SIZES[asset];
    if (known != null) return known;
    console.warn(`[profit] Unknown asset "${asset}", refusing to use default lot size`);
    return null;
  }
  return DEFAULT_LOT;
}

/** What the position earns each day from time decay if underlying and IV stay where they are (negative when you are long and paying it). */
export function thetaPerDayUsd(legs: readonly GreekLeg[]): number | null {
  let total = 0;
  for (const l of legs) {
    if (l.theta == null || !Number.isFinite(l.theta)) return null;
    const lot = resolveLotSize(l);
    if (lot == null) return null;
    total += (l.side === 'sell' ? -1 : 1) * l.theta * l.lots * lot;
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

/**
 * What time alone earns between now and the exit: each leg re-priced at the exit with price and IV unchanged (Black-Scholes),
 * which follows the real shape of decay. Null when a leg lacks what it needs.
 */
export function decayToExitUsd(legs: readonly GreekLeg[], spot: number, hoursToExit: number, nowMs: number): number | null {
  let total = 0;
  for (const l of legs) {
    if (l.iv == null || l.strike == null || !l.type || l.expiryMs == null || !(l.iv > 0)) return null;
    const lot = resolveLotSize(l);
    if (lot == null) return null;
    const T0 = Math.max((l.expiryMs - nowMs) / YEAR_MS, 1e-6), T1 = Math.max((l.expiryMs - nowMs - hoursToExit * 3_600_000) / YEAR_MS, 1e-6);
    const cp = l.type === 'call' ? 'c' : 'p';
    total += (l.side === 'sell' ? 1 : -1) * (bs(spot, l.strike, T0, l.iv, cp) - bs(spot, l.strike, T1, l.iv, cp)) * l.lots * lot;
  }
  return total;
}

export function estimateProfit(legs: readonly GreekLeg[], hoursToExit: number | null, premium: number | null, repriced?: number | null): ProfitEstimate | null {
  const perDay = thetaPerDayUsd(legs);
  if (perDay == null || hoursToExit == null || !(hoursToExit > 0)) return null;
  // decay can never earn more than the premium collected
  const raw = repriced != null && Number.isFinite(repriced) ? repriced : perDay * (hoursToExit / 24);
  return {
    perDayUsd: perDay,
    toExitUsd: premium != null && premium > 0 ? Math.min(raw, premium) : raw,
    maxUsd: premium != null && premium > 0 ? premium : null,
    hoursToExit,
    note: 'Time decay only, before fees, if BTC and IV stay where they are, and never more than the premium collected. A big move can wipe it out.',
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
