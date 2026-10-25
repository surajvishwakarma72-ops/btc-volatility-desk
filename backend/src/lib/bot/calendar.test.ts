import { describe, expect, it } from 'vitest';
import { calendarBreakeven, calendarValueAtFrontExpiry, isBackwardation, type CalendarLegs } from './calendar.js';
import { DEFAULT_REPLAY, replayRun, windowFor, type ReplayBar, type ReplayData } from './replay.js';

const MIN = 60_000;
const DAY = 86_400_000;
const FRONT = Date.parse('2026-01-03T12:00:00Z');
const legs: CalendarLegs = { strike: 80_000, frontExpiryMs: FRONT, backExpiryMs: FRONT + 2 * DAY, frontIv: 55, backIv: 40 };

describe('backwardation', () => {
  it('needs the front IV above the back IV by the threshold', () => {
    expect(isBackwardation(55, 40)).toBe(true);
    expect(isBackwardation(41, 40)).toBe(false);
    expect(isBackwardation(42, 40)).toBe(true);
    expect(isBackwardation(null, 40)).toBe(false);
    expect(isBackwardation(50, null)).toBe(false);
  });
});

describe('calendar value and breakeven at front expiry', () => {
  it('is worth most at the strike and falls away on both sides', () => {
    const at = calendarValueAtFrontExpiry(80_000, legs);
    expect(calendarValueAtFrontExpiry(78_000, legs)).toBeLessThan(at);
    expect(calendarValueAtFrontExpiry(82_000, legs)).toBeLessThan(at);
  });

  it('breakeven brackets the strike and moves outward when the debit is smaller', () => {
    const peak = calendarValueAtFrontExpiry(80_000, legs);
    const big = calendarBreakeven(legs, peak * 0.5)!;
    const small = calendarBreakeven(legs, peak * 0.2)!;
    expect(big.low).toBeLessThan(80_000);
    expect(big.high).toBeGreaterThan(80_000);
    expect(small.low).toBeLessThan(big.low);
    expect(small.high).toBeGreaterThan(big.high);
    expect(big.peak).toBeCloseTo(peak * 0.5, 6);
    // the value at each breakeven equals the debit
    expect(calendarValueAtFrontExpiry(big.low, legs)).toBeCloseTo(peak * 0.5, 4);
    expect(calendarValueAtFrontExpiry(big.high, legs)).toBeCloseTo(peak * 0.5, 4);
  });

  it('returns null when even the strike cannot repay the debit', () => {
    const peak = calendarValueAtFrontExpiry(80_000, legs);
    expect(calendarBreakeven(legs, peak * 1.2)).toBeNull();
  });
});

function data(fn: (t: number) => number, iv: (exp: number, t: number) => number | null): ReplayData {
  const from = Date.parse('2026-01-01T00:00:00Z');
  const to = Date.parse('2026-01-08T00:00:00Z');
  const bars: ReplayBar[] = [];
  for (let t = from; t <= to; t += MIN) {
    const c = fn(t);
    bars.push({ t, h: c, l: c, c });
  }
  return { first: from, last: to, barsBetween: (a, b) => bars.filter((x) => x.t >= a && x.t <= b), ivAt: iv, dvolAt: () => 45 };
}

describe('CAL_BACK replay', () => {
  const day = '2026-01-03';
  it('enters at 18:00 IST on the day after the roll, with the front expiring within 24h and the back at N2N', () => {
    const w = windowFor('CAL_BACK', day);
    const entry = Date.parse('2026-01-03T12:30:00Z');
    expect(w.entryAtMs).toBe(entry);
    expect(w.exitAtMs).toBe(Date.parse('2026-01-04T12:00:00Z') - 3_600_000); // an hour before the front expiry
  });

  it('trades only in backwardation, as a 4-leg short-front / long-back straddle calendar', () => {
    const back = data(() => 80_000, (exp) => (exp < Date.parse('2026-01-06T00:00:00Z') ? 58 : 40));
    const r = replayRun(back, 'CAL_BACK', day, 'always')!;
    expect(r).not.toBeNull();
    expect(r.legs.map((l) => `${l.side}:${l.type}`)).toEqual(['short:call', 'short:put', 'long:call', 'long:put']);
    expect(r.legs[0]!.strike).toBe(80_000);
    expect(['tp', 'hard_close', 'breakeven']).toContain(r.exitReason);
    expect(r.exitMs).toBeLessThanOrEqual(windowFor('CAL_BACK', day).exitAtMs);
    const contango = data(() => 80_000, (exp) => (exp < Date.parse('2026-01-06T00:00:00Z') ? 38 : 45));
    expect(replayRun(contango, 'CAL_BACK', day, 'always')).toBeNull();
  });

  it('a big move out of the profit zone exits on the breakeven breach', () => {
    const entry = windowFor('CAL_BACK', day).entryAtMs;
    const d = data((t) => (t < entry + 30 * MIN ? 80_000 : 80_000 + Math.min((t - entry - 30 * MIN) / MIN * 12, 4_000)), (exp) => (exp < Date.parse('2026-01-06T00:00:00Z') ? 58 : 40));
    const r = replayRun(d, 'CAL_BACK', day, 'always')!;
    expect(r.exitReason).toBe('breakeven');
    expect(r.netPnl).toBeLessThan(0);
  });

  it('never holds the short front leg through its expiry', () => {
    const d = data(() => 80_000, (exp) => (exp < Date.parse('2026-01-06T00:00:00Z') ? 58 : 40));
    const r = replayRun(d, 'CAL_BACK', day, 'always', { ...DEFAULT_REPLAY, calendar: { minBackwardation: 2, hardCloseBeforeMs: 3_600_000 } })!;
    expect(r.exitMs).toBeLessThan(Date.parse('2026-01-04T12:00:00Z'));
  });
});
