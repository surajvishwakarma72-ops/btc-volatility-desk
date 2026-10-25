import { bs, yrs } from '../../backtest/lib/pricing.js';

/**
 * Calendar spread in backwardation: SELL the current (front) expiry and BUY the N2N (back) expiry
 * at the same strike, on both the call and the put (a straddle calendar).
 *
 * Backwardation means the front IV is above the back IV. The trade is a bet that the rich front
 * premium decays faster than the back leg while price stays near the strike. Its risk is a big
 * move (the short front leg gains gamma into expiry) and event premium that sits in the front.
 */
export const CAL_ENTRY_MIN_IST = 18 * 60; // 18:00 IST, half an hour after the daily 17:30 IST expiry roll

export interface CalendarConfig {
  /** Front IV minus back IV, in vol points, needed to call it backwardation. */
  minBackwardation: number;
  /** Close this long before the sold front expiry (the short leg must never be left to settle). */
  hardCloseBeforeMs: number;
}

export const DEFAULT_CALENDAR: CalendarConfig = { minBackwardation: 2, hardCloseBeforeMs: 3_600_000 };

export function isBackwardation(frontIv: number | null, backIv: number | null, minPts = DEFAULT_CALENDAR.minBackwardation): boolean {
  return frontIv != null && backIv != null && frontIv - backIv >= minPts;
}

export interface CalendarLegs {
  strike: number;
  frontExpiryMs: number;
  backExpiryMs: number;
  frontIv: number;
  backIv: number;
}

/**
 * Value at the FRONT expiry, as a function of spot, of the whole position per 1 BTC of each leg:
 *   long back call + put (repriced with the time left and the back IV) minus the front intrinsic.
 */
export function calendarValueAtFrontExpiry(spot: number, c: CalendarLegs): number {
  const Tback = Math.max(yrs(c.backExpiryMs - c.frontExpiryMs), 1e-6);
  const back = bs(spot, c.strike, Tback, c.backIv, 'c') + bs(spot, c.strike, Tback, c.backIv, 'p');
  const front = Math.max(spot - c.strike, 0) + Math.max(c.strike - spot, 0);
  return back - front;
}

export interface Breakeven {
  low: number;
  high: number;
  /** Modelled PnL per BTC at the strike at front expiry (the profit peak). */
  peak: number;
}

/**
 * Spot levels at front expiry where the calendar breaks even, given the net debit per BTC paid at
 * entry (long back price minus short front price, both legs). Returns null when the position
 * cannot make money at expiry even at the strike.
 */
export function calendarBreakeven(c: CalendarLegs, netDebit: number): Breakeven | null {
  const f = (s: number) => calendarValueAtFrontExpiry(s, c) - netDebit;
  const peak = f(c.strike);
  if (!(peak > 0)) return null;
  const solve = (lo: number, hi: number, rising: boolean): number => {
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const v = f(mid);
      if ((v > 0) === rising) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const span = c.strike * 0.5;
  // below the strike the value rises toward it; above the strike it falls away from it
  const low = solve(c.strike - span, c.strike, true);
  const high = solve(c.strike, c.strike + span, false);
  return { low, high, peak };
}
