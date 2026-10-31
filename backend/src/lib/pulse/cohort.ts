/** Cohort rules and net P&L for Strangle Pulse. Pure; read-only paper maths. */
import { pickBodyLeg, SHORT_BAND, type ChainOption } from '../bot/strike-picker.js';
import { optionFee, futuresFee } from '../bot/costs.js';
import type { FeeRates } from '../../services/bot/delta-public.js';
import { PULSE_CONFIG } from './config.js';

export type OpenPlan =
  | { kind: 'open'; call: ChainOption; put: ChainOption }
  | { kind: 'no_valid_strikes'; missing: Array<'call' | 'put'> };

/** Picks the short call and put strictly inside the delta band; reports which sides had no strike. */
export function planOpen(chain: readonly ChainOption[], expiryMs: number): OpenPlan {
  const call = pickBodyLeg(chain, 'call', expiryMs, SHORT_BAND, 0, 0);
  const put = pickBodyLeg(chain, 'put', expiryMs, SHORT_BAND, 0, 0);
  if (call && put) return { kind: 'open', call, put };
  const missing: Array<'call' | 'put'> = [];
  if (!call) missing.push('call');
  if (!put) missing.push('put');
  return { kind: 'no_valid_strikes', missing };
}

/** Net USD P&L of one short option leg (sold at entryBid, bought back at ask), after fees and slippage. */
export function legNetPnl(i: { entryBid: number; ask: number; spot: number; fee: FeeRates }): number {
  const { lots } = PULSE_CONFIG;
  const cv = i.fee.contractValue;
  const gross = (i.entryBid - i.ask) * lots * cv;
  const feeFor = (price: number) =>
    optionFee({ price, lots, contractValue: cv, spot: i.spot, rate: i.fee.takerRate, premiumCapRate: i.fee.premiumCapRate });
  const slippage = PULSE_CONFIG.slippagePct * i.entryBid * lots * cv;
  return gross - feeFor(i.entryBid) - feeFor(i.ask) - slippage;
}

/** Net USD P&L of the futures hedge: gross minus entry and exit fees. */
export function futuresNetPnl(i: { side: 'long' | 'short'; entry: number; exit: number }): number {
  const { lots, futuresContractValue: cv, futuresTakerRate: rate } = PULSE_CONFIG;
  const dir = i.side === 'long' ? 1 : -1;
  const gross = dir * (i.exit - i.entry) * lots * cv;
  const feeFor = (price: number) => futuresFee({ price, lots, contractValue: cv, rate });
  return gross - feeFor(i.entry) - feeFor(i.exit);
}

/** True when the ask has reached the stop multiple of the entry premium. */
export function isStopHit(entryBid: number, ask: number): boolean {
  return ask >= PULSE_CONFIG.stopMultiple * entryBid;
}

/**
 * Sum of OI over the sold strike +/- oiBandStrikes listed strikes (same type and expiry).
 * Strikes without oi are skipped; null if none have it or the sold strike is not listed.
 */
export function oiBand(chain: readonly ChainOption[], type: 'call' | 'put', expiryMs: number, strike: number): number | null {
  const listed = chain.filter((o) => o.type === type && o.expiryMs === expiryMs).sort((a, b) => a.strike - b.strike);
  const idx = listed.findIndex((o) => o.strike === strike);
  if (idx < 0) return null;
  const n = PULSE_CONFIG.oiBandStrikes;
  let sum = 0;
  let seen = false;
  for (const o of listed.slice(Math.max(0, idx - n), idx + n + 1)) {
    if (o.oi === undefined) continue;
    sum += o.oi;
    seen = true;
  }
  return seen ? sum : null;
}

/**
 * Change since the last snapshot. Null if either side is missing. With nonNegative (volume), a negative
 * change means the figure is a rolling window, so it is not flow and returns null.
 */
export function delta2(now: number | null, prev: number | null, opts: { nonNegative?: boolean } = {}): number | null {
  if (now === null || prev === null) return null;
  const d = now - prev;
  return opts.nonNegative && d < 0 ? null : d;
}
