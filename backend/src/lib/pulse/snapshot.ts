/** Cohort and snapshot shapes plus the pure snapshot builder for Strangle Pulse. No db access here. */
import type { ChainOption } from '../bot/strike-picker.js';
import type { FeeRates, PerpQuote } from '../../services/bot/delta-public.js';
import { PULSE_CONFIG } from './config.js';
import type { Slot } from './grid.js';
import { delta2, futuresNetPnl, isStopHit, legNetPnl, oiBand } from './cohort.js';

export type LegName = 'call' | 'put';

/** One paper strangle cohort. Times are epoch ms; numerics are JS numbers (converted from pg strings by the store). */
export interface PulseCohort {
  id: string;
  slot: Slot;
  series_id: string;
  slot_ms: number;
  expiry_ms: number;
  status: 'open' | 'closed' | 'no_valid_strikes';
  opened_at: number;
  closed_at: number | null;
  close_reason: 'ROLL' | 'EXPIRED' | null;
  spot_entry: number | null;
  fut_entry_bid: number | null;
  fut_entry_ask: number | null;
  call_symbol: string | null;
  put_symbol: string | null;
  call_strike: number | null;
  put_strike: number | null;
  call_bid: number | null;
  put_bid: number | null;
  call_mid: number | null;
  put_mid: number | null;
  call_delta: number | null;
  put_delta: number | null;
  call_theta: number | null;
  put_theta: number | null;
  call_iv: number | null;
  put_iv: number | null;
  fee: FeeRates;
  missing: unknown;
  call_sl_at: number | null;
  put_sl_at: number | null;
  net_pnl: number | null;
}

/** One leg row of one snapshot (pulse_leg_snapshots). */
export interface LegRow {
  cohort_id: string;
  grid_ms: number;
  leg: LegName;
  minutes_since_entry: number;
  strike: number;
  expiry_ms: number;
  bid: number | null;
  ask: number | null;
  mark: number | null;
  mid: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;
  oi: number | null;
  oi_band: number | null;
  oi_change: number | null;
  volume_raw: number | null;
  volume_change: number | null;
  net_pnl: number | null;
  sl_hit: boolean;
  data_ok: boolean;
}

export interface BuiltSnapshot {
  cohortId: string;
  gridMs: number;
  cohort: {
    spot: number;
    fut_price: number;
    combined_premium: number | null;
    combined_pnl: number | null;
    pnl_pct: number | null;
    net_delta: number | null;
    fut_long_pnl: number | null;
    fut_short_pnl: number | null;
    data_ok: boolean;
  };
  legs: Record<LegName, LegRow>;
}

const nn = (v: number | undefined): number | null => (v === undefined ? null : v);

function buildLeg(
  c: PulseCohort,
  which: LegName,
  chain: readonly ChainOption[],
  perp: PerpQuote,
  prev: LegRow | undefined,
  gridMs: number,
): LegRow {
  const symbol = which === 'call' ? c.call_symbol : c.put_symbol;
  const strike = (which === 'call' ? c.call_strike : c.put_strike) ?? 0;
  const entryBid = which === 'call' ? c.call_bid : c.put_bid;
  // Sticky: the row may hold a stop that never reached the cohort, and a lower ask must not erase it.
  const stopped = (which === 'call' ? c.call_sl_at : c.put_sl_at) !== null || prev?.sl_hit === true;
  const o = symbol ? chain.find((x) => x.symbol === symbol) : undefined;
  const ok = !!o && o.ask > 0 && entryBid !== null;
  const band = o ? oiBand(chain, which, c.expiry_ms, strike) : null;
  const volume = o ? nn(o.volume) : null;

  const base = {
    cohort_id: c.id,
    grid_ms: gridMs,
    leg: which,
    minutes_since_entry: Math.round((gridMs - c.opened_at) / 60_000),
    strike,
    expiry_ms: c.expiry_ms,
  };
  if (!o) {
    return {
      ...base, bid: null, ask: null, mark: null, mid: null, delta: null, gamma: null, theta: null, vega: null, iv: null,
      oi: null, oi_band: null, oi_change: null, volume_raw: null, volume_change: null,
      net_pnl: null, sl_hit: stopped, data_ok: false,
    };
  }
  return {
    ...base,
    bid: o.bid,
    ask: o.ask,
    mark: o.mark,
    mid: (o.bid + o.ask) / 2,
    delta: o.delta,
    gamma: nn(o.gamma),
    theta: nn(o.theta),
    vega: nn(o.vega),
    iv: o.iv,
    oi: nn(o.oi),
    oi_band: band,
    oi_change: delta2(band, prev?.oi_band ?? null),
    volume_raw: volume,
    volume_change: delta2(volume, prev?.volume_raw ?? null, { nonNegative: true }),
    net_pnl: ok ? legNetPnl({ entryBid: entryBid as number, ask: o.ask, spot: perp.spot, fee: c.fee }) : null,
    sl_hit: stopped || (ok && isStopHit(entryBid as number, o.ask)),
    data_ok: ok,
  };
}

/**
 * A cohort's final net P&L, option legs only. EXPIRED prices each leg at intrinsic against spot. ROLL uses the
 * leg's current ask, else its last stored net P&L; null if any leg has neither, never a partial total.
 * Held to close: net_pnl ignores stops, which are recorded and tracked past SL_HIT.
 */
export function closeNetPnl(
  c: PulseCohort,
  reason: 'ROLL' | 'EXPIRED',
  chain: readonly ChainOption[],
  spot: number,
  last: Partial<Record<LegName, LegRow>>,
): number | null {
  let total = 0;
  for (const which of ['call', 'put'] as const) {
    const entryBid = which === 'call' ? c.call_bid : c.put_bid;
    const strike = which === 'call' ? c.call_strike : c.put_strike;
    const symbol = which === 'call' ? c.call_symbol : c.put_symbol;
    if (entryBid === null || strike === null) return null;
    let pnl: number | null;
    if (reason === 'EXPIRED') {
      const ask = Math.max(which === 'call' ? spot - strike : strike - spot, 0);
      pnl = legNetPnl({ entryBid, ask, spot, fee: c.fee });
    } else {
      const ask = chain.find((o) => o.symbol === symbol)?.ask ?? 0;
      pnl = ask > 0 ? legNetPnl({ entryBid, ask, spot, fee: c.fee }) : last[which]?.net_pnl ?? null;
    }
    if (pnl === null) return null;
    total += pnl;
  }
  return total;
}

/**
 * Builds one snapshot (two leg rows plus the cohort row) from the live chain and perp quote.
 * Pure. A leg with a missing symbol or ask <= 0 is data_ok=false and carries no P&L or new stop.
 */
export function buildSnapshot(
  cohort: PulseCohort,
  chain: readonly ChainOption[],
  perp: PerpQuote,
  prev: Partial<Record<LegName, LegRow>>,
  gridMs: number,
  _nowMs: number,
): BuiltSnapshot {
  const call = buildLeg(cohort, 'call', chain, perp, prev.call, gridMs);
  const put = buildLeg(cohort, 'put', chain, perp, prev.put, gridMs);
  const ok = call.data_ok && put.data_ok;

  let combinedPnl: number | null = null;
  let pnlPct: number | null = null;
  let netDelta: number | null = null;
  let combinedPremium: number | null = null;
  if (ok) {
    combinedPnl = (call.net_pnl as number) + (put.net_pnl as number);
    const collected = ((cohort.call_bid as number) + (cohort.put_bid as number)) * PULSE_CONFIG.lots * cohort.fee.contractValue;
    pnlPct = collected > 0 ? (combinedPnl / collected) * 100 : null;
    netDelta = (call.delta as number) - (put.delta as number);
    combinedPremium = (call.ask as number) + (put.ask as number);
  }

  const futLong =
    cohort.fut_entry_ask === null ? null : futuresNetPnl({ side: 'long', entry: cohort.fut_entry_ask, exit: perp.bid });
  const futShort =
    cohort.fut_entry_bid === null ? null : futuresNetPnl({ side: 'short', entry: cohort.fut_entry_bid, exit: perp.ask });

  return {
    cohortId: cohort.id,
    gridMs,
    cohort: {
      spot: perp.spot,
      fut_price: perp.mark,
      combined_premium: combinedPremium,
      combined_pnl: combinedPnl,
      pnl_pct: pnlPct,
      net_delta: netDelta,
      fut_long_pnl: futLong,
      fut_short_pnl: futShort,
      data_ok: ok,
    },
    legs: { call, put },
  };
}
