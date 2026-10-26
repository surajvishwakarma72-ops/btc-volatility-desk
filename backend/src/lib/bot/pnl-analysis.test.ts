import { describe, expect, it } from 'vitest';
import { analyzeSeries, analyzeTrades, type SeriesPoint, type TradeRec } from './pnl-analysis.js';

const MIN = 60_000, T0 = Date.parse('2026-10-26T04:30:00Z');
const pts = (nets: number[], startMin = 0): SeriesPoint[] => nets.map((net, i) => ({ t: T0 + (startMin + i) * MIN, net, gross: net + 1, spot: 80_000 + i, pct: net / 200 }));

describe('one trade, minute by minute', () => {
  it('finds the peak, the trough, what was given back, the worst fall from a high and the time in profit', () => {
    const s = analyzeSeries(pts([0, 4, 8, 6, 3, -2, -5, 1, 5, 2]));
    expect(s.minutes).toBe(10);
    expect(s.holdMin).toBe(9);
    expect(s.first).toBe(0);
    expect(s.last).toBe(2);
    expect(s.peak).toMatchObject({ net: 8, atMin: 2 });
    expect(s.trough).toMatchObject({ net: -5, atMin: 6 });
    expect(s.gaveBack).toBe(6);
    expect(s.maxDrawdown).toMatchObject({ amount: 13, fromT: T0 + 2 * MIN, toT: T0 + 6 * MIN });
    expect(s.timeInProfitPct).toBeCloseTo(70, 6); // 7 of 10 minutes above zero
    expect(s.biggestMinute).toMatchObject({ change: 6, t: T0 + 7 * MIN });
    expect(s.avgAbsMinute).toBeCloseTo((4 + 4 + 2 + 3 + 5 + 3 + 6 + 4 + 3) / 9, 6);
    expect(s.gapMinutes).toBe(0);
  });
  it('counts minutes the recorder missed, and copes with an empty or one-point series', () => {
    const p = [...pts([0, 1]), ...pts([2], 5)]; // a gap of 3 minutes between minute 1 and minute 5
    expect(analyzeSeries(p).gapMinutes).toBe(3);
    expect(analyzeSeries([])).toMatchObject({ minutes: 0, peak: null, maxDrawdown: null, timeInProfitPct: null });
    const one = analyzeSeries(pts([5]));
    expect(one).toMatchObject({ minutes: 1, holdMin: 0, gaveBack: 0, avgAbsMinute: null });
  });
});

const trade = (n: number, net: number, strategy = 'ASIA_SHORT', margin = 200): TradeRec => ({
  id: 't' + n, strategy, book: 'always', dateKey: '2026-10-' + String(10 + n), entryMs: T0 + n * 86_400_000, exitMs: T0 + n * 86_400_000 + 3_600_000, net, gross: net + 2, fees: 2, margin, reason: net > 0 ? 'tp' : 'stop',
});

describe('all closed trades as one run', () => {
  const trades = [trade(1, 10), trade(2, 8), trade(3, -20), trade(4, -5), trade(5, 12), trade(6, 4, 'EVE_LONG')];
  const { equity, stats } = analyzeTrades(trades);

  it('builds the cumulative curve in exit order with the drawdown under the running high', () => {
    expect(equity.map((e) => e.cum)).toEqual([10, 18, -2, -7, 5, 9]);
    expect(equity.map((e) => e.dd)).toEqual([0, 0, 20, 25, 13, 9]);
    expect(equity[2]).toMatchObject({ id: 't3', n: 3, reason: 'stop' });
  });
  it('computes the statistics a trader reads', () => {
    expect(stats.trades).toBe(6);
    expect(stats.winRate).toBeCloseTo(4 / 6, 9);
    expect(stats.netTotal).toBe(9);
    expect(stats.feesTotal).toBe(12);
    expect(stats.grossTotal).toBe(21);
    expect(stats.avgWin).toBeCloseTo(8.5, 9);
    expect(stats.avgLoss).toBeCloseTo(-12.5, 9);
    expect(stats.payoff).toBeCloseTo(8.5 / 12.5, 9);
    expect(stats.profitFactor).toBeCloseTo(34 / 25, 9);
    expect(stats.expectancy).toBeCloseTo(1.5, 9);
    expect(stats.maxDrawdown).toEqual({ amount: 25, fromN: 2, toN: 4 });
    expect(stats.longestWinStreak).toBe(2);
    expect(stats.longestLossStreak).toBe(2);
    expect(stats.best!.id).toBe('t5');
    expect(stats.worst!.id).toBe('t3');
    expect(stats.avgHoldMin).toBeCloseTo(60, 6);
    expect(stats.avgReturnOnMargin).toBeCloseTo(9 / 6 / 200, 9);
    expect(stats.byStrategy).toEqual([{ strategy: 'ASIA_SHORT', trades: 5, net: 5, winRate: 0.6 }, { strategy: 'EVE_LONG', trades: 1, net: 4, winRate: 1 }]);
  });
  it('has no profit factor before the first loss, and empty input gives empty statistics', () => {
    expect(analyzeTrades([trade(1, 5), trade(2, 3)]).stats.profitFactor).toBeNull();
    const e = analyzeTrades([]);
    expect(e.equity).toEqual([]);
    expect(e.stats).toMatchObject({ trades: 0, winRate: null, expectancy: null, maxDrawdown: null, best: null });
  });
});
