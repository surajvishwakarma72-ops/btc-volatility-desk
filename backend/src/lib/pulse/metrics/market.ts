/** Skew and term structure for Strangle Pulse. Pure; a missing or unusable quote gives null. */
import type { ChainOption } from '../../bot/strike-picker.js';
import { METRIC_CONFIG } from '../config.js';
import type { Slot } from '../grid.js';

type N = number | null;

export interface MarketRow {
  grid_ms: number;
  slot: Slot;
  expiry_ms: number;
  sampled_ms: number;
  spot: number;
  atm_iv: N;
  call25_iv: N;
  put25_iv: N;
  rr25: N;
}

const TARGET_DELTA = 0.25;

/** IV is in vol points; NaN, zero and negative mean no usable quote. */
const usable = (o: ChainOption): boolean => Number.isFinite(o.iv) && o.iv > 0;

/** The option nearest 0.25 delta, or null when even the nearest is outside the band. */
function near25(side: readonly ChainOption[]): N {
  let best: ChainOption | null = null;
  for (const o of side) {
    if (!Number.isFinite(o.delta)) continue;
    if (best === null || Math.abs(o.delta - TARGET_DELTA) < Math.abs(best.delta - TARGET_DELTA)) best = o;
  }
  return best !== null && Math.abs(best.delta - TARGET_DELTA) <= METRIC_CONFIG.nearDeltaBand ? best.iv : null;
}

/** Mean call and put IV at the strike nearest spot that has both sides quoted. */
function atmIv(calls: readonly ChainOption[], puts: readonly ChainOption[], spot: number): N {
  const putAt = new Map(puts.map((p) => [p.strike, p]));
  let best: { gap: number; iv: number } | null = null;
  for (const c of calls) {
    const p = putAt.get(c.strike);
    if (!p) continue;
    const gap = Math.abs(c.strike - spot);
    if (best === null || gap < best.gap) best = { gap, iv: (c.iv + p.iv) / 2 };
  }
  return best === null ? null : best.iv;
}

export function marketRow(chain: readonly ChainOption[], slot: Slot, expiryMs: number, spot: number, gridMs: number, nowMs: number): MarketRow {
  const mine = chain.filter((o) => o.expiryMs === expiryMs && usable(o));
  const calls = mine.filter((o) => o.type === 'call');
  const puts = mine.filter((o) => o.type === 'put');
  const call25 = near25(calls);
  const put25 = near25(puts);
  return {
    grid_ms: gridMs, slot, expiry_ms: expiryMs, sampled_ms: nowMs, spot,
    atm_iv: atmIv(calls, puts, spot),
    call25_iv: call25, put25_iv: put25,
    rr25: call25 !== null && put25 !== null ? call25 - put25 : null,
  };
}

/** True when the current expiry's ATM IV exceeds the next one's by more than termInversionMinPts; null when either is missing. */
export function termInverted(currentAtm: N, nextAtm: N): boolean | null {
  if (currentAtm === null || nextAtm === null || !Number.isFinite(currentAtm) || !Number.isFinite(nextAtm)) return null;
  return currentAtm - nextAtm > METRIC_CONFIG.termInversionMinPts;
}
