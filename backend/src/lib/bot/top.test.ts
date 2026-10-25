import { describe, expect, it } from 'vitest';
import type { GroupStats } from './analytics.js';
import { pickTop } from './top.js';

const g = (key: string, trades: number, avgPnl: number, over: Partial<GroupStats> = {}): GroupStats => ({
  key, trades, netPnl: avgPnl * trades, avgPnl, medianPnl: avgPnl, winRate: 0.55, stopRate: 0.3, tpRate: 0.2, avgWin: 5, avgLoss: -5,
  expectancyPerMarginPct: 0, maxDrawdown: 120, worstTrade: -20, bestTrade: 20, fees: 10, avgGiveBack: 1, sharpe: null, ...over,
});

describe('pickTop', () => {
  it('returns null with no trades', () => {
    expect(pickTop([])).toBeNull();
    expect(pickTop([g('A|always', 0, 0)])).toBeNull();
  });

  it('ranks by average PnL per trade among books with enough trades, and explains why', () => {
    const t = pickTop([g('A|always', 40, 1.2), g('B|always', 40, 2.5), g('C|always', 5, 9)], { minTrades: 20, label: (k) => `<${k}>` })!;
    expect(t.key).toBe('B|always');
    expect(t.confident).toBe(true);
    expect(t.allLosing).toBe(false);
    expect(t.runnerUp).toEqual({ key: 'A|always', avgPnl: 1.2 });
    expect(t.reason).toMatch(/<B\|always> leads/);
    expect(t.reason).toMatch(/\+\$2\.50 per trade/);
    expect(t.reason).toMatch(/<A\|always>, averages \+\$1\.20/);
    expect(t.reason).toMatch(/fewer than 20 trades were left out/);
  });

  it('an early read when no book has enough trades', () => {
    const t = pickTop([g('A|always', 6, 3), g('B|always', 4, 1)])!;
    expect(t.key).toBe('A|always');
    expect(t.confident).toBe(false);
    expect(t.reason).toMatch(/only 6 trades so far/);
  });

  it('says plainly when every book loses money', () => {
    const t = pickTop([g('A|always', 30, -2), g('B|always', 30, -0.5)])!;
    expect(t.key).toBe('B|always');
    expect(t.allLosing).toBe(true);
    expect(t.reason).toMatch(/least bad/);
    expect(t.reason).toMatch(/no strategy is profitable yet/);
  });
});
