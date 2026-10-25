import { describe, expect, it } from 'vitest';
import { dueEntries, floorToMinute, istDateKey, istMidnightMs, runKey, runWindow } from './schedule.js';
import { computePnl, evaluateExit, exitConfigFor, calendarExitConfig } from './rules.js';
import { feeToRiskOk, futuresFee, optionFee, walkBook } from './costs.js';
import { chooseLeverage, futuresLots } from './sizing.js';
import { checkRisk } from './risk-guard.js';
import { pickAtmStraddle, pickBodyLeg, pickWing, type ChainOption } from './strike-picker.js';
import type { Leg, PositionSnapshot } from './types.js';

const MIN = 60_000;
const EXP = Date.parse('2026-10-30T12:00:00Z');

function opt(o: Partial<ChainOption> & Pick<ChainOption, 'symbol' | 'type' | 'strike' | 'delta'>): ChainOption {
  return { expiryMs: EXP, bid: 10, ask: 12, mark: 11, iv: 50, ...o };
}

describe('schedule', () => {
  it('maps IST dates and clock windows exactly', () => {
    // 2026-10-26 10:00 IST == 04:30 UTC
    const ms = Date.parse('2026-10-26T04:30:00Z');
    expect(istDateKey(ms)).toBe('2026-10-26');
    expect(runWindow('ASIA_SHORT', '2026-10-26').entryAtMs).toBe(ms);
    expect(runWindow('ASIA_SHORT', '2026-10-26').exitAtMs).toBe(ms + 6 * 60 * MIN);
  });

  it('NY short exits at 07:00 IST the next day; iron condors run a full 24h', () => {
    const ny = runWindow('NY_SHORT', '2026-10-26');
    expect(ny.exitAtMs - ny.entryAtMs).toBe(8.5 * 60 * MIN);
    const ic = runWindow('ASIA_IC', '2026-10-26');
    expect(ic.exitAtMs - ic.entryAtMs).toBe(24 * 60 * MIN);
    const nyIc = runWindow('NY_IC', '2026-10-26');
    expect(nyIc.exitAtMs - nyIc.entryAtMs).toBe(24 * 60 * MIN);
  });

  it('IST date key rolls over at IST midnight, not UTC', () => {
    // 2026-10-25 18:29 UTC is 23:59 IST on the 25th; one minute later is the 26th IST
    expect(istDateKey(Date.parse('2026-10-25T18:29:00Z'))).toBe('2026-10-25');
    expect(istDateKey(Date.parse('2026-10-25T18:30:00Z'))).toBe('2026-10-26');
    expect(istMidnightMs('2026-10-26')).toBe(Date.parse('2026-10-25T18:30:00Z'));
  });

  it('dueEntries fires inside the grace window only', () => {
    const entry = runWindow('ASIA_SHORT', '2026-10-26').entryAtMs;
    expect(dueEntries(entry - MIN).some((d) => d.id === 'ASIA_SHORT')).toBe(false);
    expect(dueEntries(entry).some((d) => d.id === 'ASIA_SHORT' && d.dateKey === '2026-10-26')).toBe(true);
    expect(dueEntries(entry + 9 * MIN).some((d) => d.id === 'ASIA_SHORT')).toBe(true);
    expect(dueEntries(entry + 11 * MIN).some((d) => d.id === 'ASIA_SHORT')).toBe(false);
  });

  it('builds an idempotent run key and floors to the minute', () => {
    expect(runKey('NY_IC', '2026-10-26', 'gated')).toBe('NY_IC:2026-10-26:gated');
    expect(floorToMinute(61_999)).toBe(60_000);
  });
});

const call: Leg = { symbol: 'C', type: 'call', side: 'short', strike: 82000, expiryMs: EXP, lots: 100, entryPrice: 100, role: 'body' };
const put: Leg = { symbol: 'P', type: 'put', side: 'short', strike: 79000, expiryMs: EXP, lots: 100, entryPrice: 100, role: 'body' };

function snap(over: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    legs: [call, put],
    marks: [{ symbol: 'C', mark: 100 }, { symbol: 'P', mark: 100 }],
    spot: 80500,
    marginUsd: 1000,
    contractValue: 0.001,
    feesPaidUsd: 0,
    ...over,
  };
}

describe('computePnl', () => {
  it('shorts gain when marks fall and lose when they rise', () => {
    // 100 lots x 0.001 BTC = 0.1 BTC per leg; a 20 USD fall on each short = 2 + 2 USD
    const p = computePnl(snap({ marks: [{ symbol: 'C', mark: 80 }, { symbol: 'P', mark: 80 }] }));
    expect(p.grossPnl).toBeCloseTo(4, 6);
    const l = computePnl(snap({ marks: [{ symbol: 'C', mark: 130 }, { symbol: 'P', mark: 100 }] }));
    expect(l.grossPnl).toBeCloseTo(-3, 6);
  });

  it('subtracts fees from net PnL and expresses it as a share of margin', () => {
    const p = computePnl(snap({ marks: [{ symbol: 'C', mark: 80 }, { symbol: 'P', mark: 80 }], feesPaidUsd: 1 }));
    expect(p.netPnl).toBeCloseTo(3, 6);
    expect(p.pctOfMargin).toBeCloseTo(0.003, 6);
  });

  it('longs gain when marks rise', () => {
    const longCall: Leg = { ...call, side: 'long' };
    const p = computePnl(snap({ legs: [longCall], marks: [{ symbol: 'C', mark: 150 }] }));
    expect(p.grossPnl).toBeCloseTo(5, 6);
  });
});

describe('evaluateExit', () => {
  const cfg = exitConfigFor('ASIA_SHORT', 10_000_000);

  it('holds while nothing triggers', () => {
    expect(evaluateExit(snap(), cfg, 1).action).toBe('hold');
  });

  it('one short leg doubling stops the WHOLE position', () => {
    const d = evaluateExit(snap({ marks: [{ symbol: 'C', mark: 200 }, { symbol: 'P', mark: 40 }] }), cfg, 1);
    expect(d).toMatchObject({ action: 'exit', reason: 'stop' });
  });

  it('stop has priority over take profit and ignores long wings', () => {
    const wing: Leg = { ...call, symbol: 'W', side: 'long', role: 'wing', entryPrice: 5 };
    const hold = evaluateExit(
      snap({ legs: [call, put, wing], marks: [{ symbol: 'C', mark: 100 }, { symbol: 'P', mark: 100 }, { symbol: 'W', mark: 50 }] }),
      cfg,
      1,
    );
    expect(hold.action).toBe('hold'); // a wing at 10x does not trip the 2x stop
  });

  it('takes profit at 10% of margin', () => {
    // marks to 0 => 100 lots x 0.001 x 100 x 2 legs = 20 USD gross; margin 100 => 20%
    const d = evaluateExit(snap({ marginUsd: 100, marks: [{ symbol: 'C', mark: 0 }, { symbol: 'P', mark: 0 }] }), cfg, 1);
    expect(d).toMatchObject({ action: 'exit', reason: 'tp' });
  });

  it('time exit fires at the scheduled time', () => {
    expect(evaluateExit(snap(), cfg, 9_999_999).action).toBe('hold');
    expect(evaluateExit(snap(), cfg, 10_000_000)).toMatchObject({ action: 'exit', reason: 'time' });
  });

  it('long straddle: -10% of margin stops, +50% targets', () => {
    const lc: Leg = { ...call, side: 'long' };
    const lp: Leg = { ...put, side: 'long' };
    const lcfg = exitConfigFor('EVE_LONG', 10_000_000);
    const lose = evaluateExit(
      snap({ legs: [lc, lp], marginUsd: 20, marks: [{ symbol: 'C', mark: 80 }, { symbol: 'P', mark: 80 }] }),
      lcfg,
      1,
    );
    expect(lose).toMatchObject({ action: 'exit', reason: 'sl' });
    const win = evaluateExit(
      snap({ legs: [lc, lp], marginUsd: 20, marks: [{ symbol: 'C', mark: 200 }, { symbol: 'P', mark: 100 }] }),
      lcfg,
      1,
    );
    expect(win).toMatchObject({ action: 'exit', reason: 'tp' });
  });

  it('iron condor has no intraday time exit before its 24h mark', () => {
    const w = runWindow('ASIA_IC', '2026-10-26');
    const icCfg = exitConfigFor('ASIA_IC', w.exitAtMs);
    expect(evaluateExit(snap(), icCfg, w.entryAtMs + 6 * 60 * MIN).action).toBe('hold');
    expect(evaluateExit(snap(), icCfg, w.exitAtMs)).toMatchObject({ reason: 'time' });
  });

  it('calendar: exits on breakeven breach, and hard-closes an hour before front expiry', () => {
    const cal = calendarExitConfig({ low: 79000, high: 82000 }, EXP);
    expect(evaluateExit(snap({ spot: 80500 }), cal, EXP - 2 * 3_600_000).action).toBe('hold');
    expect(evaluateExit(snap({ spot: 78500 }), cal, 1)).toMatchObject({ reason: 'breakeven' });
    expect(evaluateExit(snap({ spot: 80500 }), cal, EXP - 3_600_000)).toMatchObject({ reason: 'hard_close' });
  });
});

describe('costs', () => {
  it('walks the book and reports partial fills and slippage', () => {
    const asks = [[100, 30], [101, 50], [105, 100]] as const;
    const f = walkBook(asks, 100, 'buy');
    expect(f.filled).toBe(100);
    expect(f.avgPrice).toBeCloseTo((30 * 100 + 50 * 101 + 20 * 105) / 100, 6);
    expect(f.slippage).toBeLessThan(0);
    const partial = walkBook([[100, 10]], 50, 'sell');
    expect(partial.partial).toBe(true);
    expect(partial.filled).toBe(10);
    expect(walkBook([], 5, 'buy').filled).toBe(0);
  });

  it('options fee is the lower of notional rate and premium cap, plus GST', () => {
    // notional 80000 x 100 x 0.001 = 8000; 0.03% = 2.4. premium 100 x 0.1 = 10; cap 10% = 1.0
    const capped = optionFee({ price: 100, lots: 100, contractValue: 0.001, spot: 80000, rate: 0.0003, premiumCapRate: 0.1 });
    expect(capped).toBeCloseTo(1.0 * 1.18, 6);
    const uncapped = optionFee({ price: 1000, lots: 100, contractValue: 0.001, spot: 80000, rate: 0.0003, premiumCapRate: 0.1 });
    expect(uncapped).toBeCloseTo(2.4 * 1.18, 6);
  });

  it('futures fee and the fee-to-risk filter', () => {
    // 25 lots at 80000 = 2000 USD notional, 0.05% = 1.0, +GST = 1.18 per side
    expect(futuresFee({ price: 80000, lots: 25, contractValue: 0.001, rate: 0.0005 })).toBeCloseTo(1.18, 6);
    expect(feeToRiskOk(2.36, 5)).toBe(false);
    expect(feeToRiskOk(1.0, 5)).toBe(true);
  });
});

describe('futures sizing', () => {
  it('wider stops reduce lots so risk stays constant', () => {
    const tight = futuresLots({ riskUsd: 5, stopDistance: 200, contractValue: 0.001, maxLots: 25 });
    expect(tight?.lots).toBe(25);
    const wide = futuresLots({ riskUsd: 5, stopDistance: 400, contractValue: 0.001, maxLots: 25 });
    expect(wide?.lots).toBe(12);
    expect(wide!.riskAtStopUsd).toBeLessThanOrEqual(5);
  });

  it('caps at max lots and rejects stops too wide for one lot', () => {
    expect(futuresLots({ riskUsd: 5, stopDistance: 50, contractValue: 0.001, maxLots: 25 })?.lots).toBe(25);
    expect(futuresLots({ riskUsd: 0.1, stopDistance: 500, contractValue: 0.001, maxLots: 25 })).toBeNull();
  });

  it('leverage is chosen so the stop stays within 40% of liquidation', () => {
    // entry 80000, stop 200: ceiling = floor(0.4 x 80000 / 200) = 160 -> capped by max
    expect(chooseLeverage(80000, 200, 50)).toBe(50);
    expect(chooseLeverage(80000, 200, 200)).toBe(160);
    expect(chooseLeverage(80000, 2000, 50)).toBe(16);
    expect(chooseLeverage(80000, 40000, 50)).toBeNull();
  });
});

describe('risk guard', () => {
  const limits = { maxOpenMarginUsd: 5000, maxOpenPositions: 6, maxDailyLossUsd: 300, maxMonthlyLossUsd: 900 };
  const base = { openMarginUsd: 1000, openPositions: 2, dailyPnlUsd: 0, monthlyPnlUsd: 0, paused: false, killSwitch: false };

  it('allows a normal entry', () => {
    expect(checkRisk({ strategy: 'ASIA_SHORT', marginUsd: 800, shortVol: true }, base, limits, { eventInWindow: false })).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it('blocks on kill switch, pause, loss limits, margin, count and events', () => {
    const r = checkRisk(
      { strategy: 'NY_SHORT', marginUsd: 6000, shortVol: true },
      { ...base, openPositions: 6, dailyPnlUsd: -300, monthlyPnlUsd: -900, paused: true, killSwitch: true },
      limits,
      { eventInWindow: true },
    );
    expect(r.allowed).toBe(false);
    expect(r.reasons).toHaveLength(7);
  });

  it('events only block short-vol structures', () => {
    expect(checkRisk({ strategy: 'EVE_LONG', marginUsd: 100, shortVol: false }, base, limits, { eventInWindow: true }).allowed).toBe(true);
  });
});

describe('strike picker', () => {
  const chain: ChainOption[] = [
    opt({ symbol: 'C-83000', type: 'call', strike: 83000, delta: 0.09 }),
    opt({ symbol: 'C-82500', type: 'call', strike: 82500, delta: 0.12 }),
    opt({ symbol: 'C-82000', type: 'call', strike: 82000, delta: 0.17 }),
    opt({ symbol: 'C-84000', type: 'call', strike: 84000, delta: 0.04 }),
    opt({ symbol: 'P-78000', type: 'put', strike: 78000, delta: 0.14 }),
    opt({ symbol: 'P-77000', type: 'put', strike: 77000, delta: 0.07 }),
    opt({ symbol: 'P-76000', type: 'put', strike: 76000, delta: 0.04 }),
    opt({ symbol: 'C-80000', type: 'call', strike: 80000, delta: 0.5 }),
    opt({ symbol: 'P-80000', type: 'put', strike: 80000, delta: 0.5 }),
  ];

  it('picks the in-band strike nearest the target delta', () => {
    expect(pickBodyLeg(chain, 'call', EXP)?.symbol).toBe('C-82500');
    expect(pickBodyLeg(chain, 'put', EXP)?.symbol).toBe('P-78000');
  });

  it('falls back to the nearest strike below the band, and skips unfillable quotes', () => {
    const noBand = chain.filter((o) => o.symbol !== 'P-78000');
    expect(pickBodyLeg(noBand, 'put', EXP)?.symbol).toBe('P-77000');
    const noBid = chain.map((o) => (o.symbol === 'C-82500' ? { ...o, bid: 0 } : o));
    expect(pickBodyLeg(noBid, 'call', EXP)?.symbol).not.toBe('C-82500');
  });

  it('as a last resort accepts a strike just above the band, but not far above it', () => {
    const sparse = [
      opt({ symbol: 'C-A', type: 'call', strike: 82800, delta: 0.152 }),
      opt({ symbol: 'C-B', type: 'call', strike: 82400, delta: 0.202 }),
    ];
    expect(pickBodyLeg(sparse, 'call', EXP)?.symbol).toBe('C-A');
    expect(pickBodyLeg([sparse[1]!], 'call', EXP)).toBeNull();
  });

  it('never sells a far-OTM strike as the body just because nothing sits in the band', () => {
    const farOnly = [opt({ symbol: 'C-FAR', type: 'call', strike: 90000, delta: 0.04 })];
    expect(pickBodyLeg(farOnly, 'call', EXP)).toBeNull();
  });

  it('picks a wing further out than the body', () => {
    const body = chain.find((o) => o.symbol === 'C-82500')!;
    expect(pickWing(chain, body, 0.04)?.symbol).toBe('C-84000');
    const putBody = chain.find((o) => o.symbol === 'P-78000')!;
    expect(pickWing(chain, putBody, 0.04)?.symbol).toBe('P-76000');
  });

  it('finds the ATM straddle nearest spot', () => {
    const s = pickAtmStraddle(chain, EXP, 80100);
    expect(s?.call.strike).toBe(80000);
    expect(s?.put.strike).toBe(80000);
    expect(pickAtmStraddle(chain, EXP + 1, 80100)).toBeNull();
  });
});
