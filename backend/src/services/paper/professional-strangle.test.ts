import { describe, it, expect } from 'vitest';
import {
  getISTTime,
  formatExpiryDate,
  formatExpiryIso,
  findNextWeeklyExpiry,
  findN2NExpiry,
  pickWeeklyLongStrangle,
  pickDailyShortStrangle,
} from './professional-strangle.js';
import type { BoardRow } from './market.js';

describe('Professional Strangle Strategy (Paper Trading Only)', () => {
  it('correctly calculates IST time and day of week', () => {
    // 2026-11-06 12:00:00 UTC = 2026-11-06 17:30:00 IST (Friday)
    const friEpoch = Date.UTC(2026, 10, 6, 12, 0, 0);
    const ist = getISTTime(friEpoch);
    expect(ist.dayOfWeek).toBe(5);
    expect(ist.dayName).toBe('Friday');
    expect(ist.dateKey).toBe('2026-11-06');
    expect(ist.hour).toBe(17);
    expect(ist.minute).toBe(30);

    // 2026-11-09 05:30:00 UTC = 2026-11-09 11:00:00 IST (Monday)
    const monEpoch = Date.UTC(2026, 10, 9, 5, 30, 0);
    const monIst = getISTTime(monEpoch);
    expect(monIst.dayOfWeek).toBe(1);
    expect(monIst.dayName).toBe('Monday');
    expect(monIst.dateKey).toBe('2026-11-09');
  });

  it('formats expiry dates correctly', () => {
    const epoch = Date.UTC(2026, 10, 6, 12, 0, 0); // 06 Nov 2026
    expect(formatExpiryDate(epoch)).toBe('061126');
    expect(formatExpiryIso(epoch)).toBe('2026-11-06');
  });

  it('finds the next weekly expiry (Friday settlement >= 3.5 days away)', () => {
    // Current time: Wednesday 04 Nov 2026
    const now = Date.UTC(2026, 10, 4, 10, 0, 0);
    const expDaily0 = Date.UTC(2026, 10, 4, 12, 0, 0); // today
    const expDaily1 = Date.UTC(2026, 10, 5, 12, 0, 0); // Thursday (1 day)
    const expFriThisWeek = Date.UTC(2026, 10, 6, 12, 0, 0); // Friday (2 days away - too close for weekly structure)
    const expFriNextWeek = Date.UTC(2026, 10, 13, 12, 0, 0); // Next Friday (9 days away)
    const expFri2W = Date.UTC(2026, 10, 20, 12, 0, 0); // 16 days away

    const expiries = [expDaily0, expDaily1, expFriThisWeek, expFriNextWeek, expFri2W];
    const picked = findNextWeeklyExpiry(expiries, now);
    expect(picked).toBe(expFriNextWeek);
  });

  it('finds N2N (next-to-next) expiry', () => {
    const now = Date.UTC(2026, 10, 4, 10, 0, 0);
    const exp1 = Date.UTC(2026, 10, 5, 12, 0, 0); // 1DTE
    const exp2 = Date.UTC(2026, 10, 6, 12, 0, 0); // 2DTE (N2N)
    const exp3 = Date.UTC(2026, 10, 7, 12, 0, 0);

    const picked = findN2NExpiry([exp1, exp2, exp3], now);
    expect(picked).toBe(exp2);
  });

  it('picks weekly long strangle strikes with OTM delta ~0.20-0.30', () => {
    const exp = Date.UTC(2026, 10, 13, 12, 0, 0);
    const spot = 70000;
    const makeRow = (type: 'call' | 'put', strike: number, delta: number): BoardRow => ({
      symbol: `${type === 'call' ? 'C' : 'P'}-BTC-${strike}-131126`,
      type,
      strike,
      expiryMs: exp,
      bid: 500,
      ask: 520,
      bidSize: 10,
      askSize: 10,
      mark: 510,
      iv: 50,
      delta: type === 'call' ? delta : -delta,
      gamma: 0.0001,
      theta: -10,
      vega: 20,
      oi: 100,
      volume: 50,
      tick: 0.1,
    });

    const rows: BoardRow[] = [
      makeRow('call', 70000, 0.5),
      makeRow('call', 72000, 0.38),
      makeRow('call', 74000, 0.24), // target call
      makeRow('call', 77000, 0.12),
      makeRow('put', 70000, 0.5),
      makeRow('put', 68000, 0.36),
      makeRow('put', 66000, 0.25), // target put
      makeRow('put', 63000, 0.11),
    ];

    const strangle = pickWeeklyLongStrangle(rows, exp, spot);
    expect(strangle).not.toBeNull();
    expect(strangle!.call.strike).toBe(74000);
    expect(strangle!.put.strike).toBe(66000);
  });

  it('picks daily short strangle strikes in short delta band', () => {
    const exp = Date.UTC(2026, 10, 6, 12, 0, 0);
    const spot = 70000;
    const makeRow = (type: 'call' | 'put', strike: number, delta: number): BoardRow => ({
      symbol: `${type === 'call' ? 'C' : 'P'}-BTC-${strike}-061126`,
      type,
      strike,
      expiryMs: exp,
      bid: 200,
      ask: 220,
      bidSize: 10,
      askSize: 10,
      mark: 210,
      iv: 50,
      delta: type === 'call' ? delta : -delta,
      gamma: 0.0001,
      theta: -10,
      vega: 20,
      oi: 100,
      volume: 50,
      tick: 0.1,
    });

    const rows: BoardRow[] = [
      makeRow('call', 71000, 0.4),
      makeRow('call', 73000, 0.25),
      makeRow('call', 75000, 0.13), // target body call
      makeRow('call', 78000, 0.04),
      makeRow('put', 69000, 0.4),
      makeRow('put', 67000, 0.24),
      makeRow('put', 65000, 0.12), // target body put
      makeRow('put', 62000, 0.03),
    ];

    const strangle = pickDailyShortStrangle(rows, exp, spot);
    expect(strangle).not.toBeNull();
    expect(strangle!.call.strike).toBe(75000);
    expect(strangle!.put.strike).toBe(65000);
  });
});
