import { describe, expect, it } from 'vitest';
import { buildAnalytics, exitGrid, groupStats, ivBand, weekKey, type RunRecord } from './analytics.js';
import { DEFAULT_REPLAY, expiriesAfter, replayAll, replayRun, type ReplayBar, type ReplayData } from './replay.js';
import { runWindow } from './schedule.js';

const MIN = 60_000;

function dataFrom(fn: (t: number) => number, opts: { iv?: number | null; dvol?: number | null; from?: number; to?: number } = {}): ReplayData {
  const from = opts.from ?? Date.parse('2026-01-01T00:00:00Z');
  const to = opts.to ?? Date.parse('2026-01-06T00:00:00Z');
  const bars: ReplayBar[] = [];
  for (let t = from; t <= to; t += MIN) {
    const c = fn(t);
    bars.push({ t, h: c, l: c, c });
  }
  return {
    first: from,
    last: to,
    barsBetween: (a, b) => bars.filter((x) => x.t >= a && x.t <= b),
    ivAt: () => (opts.iv === undefined ? 40 : opts.iv),
    dvolAt: () => (opts.dvol === undefined ? 45 : opts.dvol),
  };
}

describe('expiries', () => {
  it('daily expiries settle at 12:00 UTC and skip one already passed', () => {
    const t = Date.parse('2026-01-02T04:30:00Z');
    expect(expiriesAfter(t, 3)).toEqual([Date.parse('2026-01-02T12:00:00Z'), Date.parse('2026-01-03T12:00:00Z'), Date.parse('2026-01-04T12:00:00Z')]);
    expect(expiriesAfter(Date.parse('2026-01-02T13:00:00Z'), 1)).toEqual([Date.parse('2026-01-03T12:00:00Z')]);
  });
});

describe('replayRun', () => {
  it('a flat market short strangle holds to its time exit with a small, fee-sensitive result', () => {
    const r = replayRun(dataFrom(() => 80_000), 'ASIA_SHORT', '2026-01-03', 'always')!;
    expect(r).not.toBeNull();
    expect(r.exitReason).toBe('time');
    expect(r.exitMs).toBe(runWindow('ASIA_SHORT', '2026-01-03').exitAtMs);
    expect(r.feesUsd).toBeGreaterThan(0);
    expect(r.netPnl).toBeLessThan(5);
    expect(r.path[0]).toEqual([0, expect.any(Number)]);
    expect(r.path[r.path.length - 1]![0]).toBe(360);
    expect(r.legs.map((l) => l.side)).toEqual(['short', 'short']);
  });

  it('a sharp rally stops the short strangle early, closing every leg', () => {
    const entry = runWindow('NY_SHORT', '2026-01-03').entryAtMs;
    const d = dataFrom((t) => (t < entry + 30 * MIN ? 80_000 : 80_000 + (t - entry - 30 * MIN) / MIN * 60));
    const r = replayRun(d, 'NY_SHORT', '2026-01-03', 'always')!;
    expect(r.exitReason).toBe('stop');
    expect(r.exitMs).toBeLessThan(entry + 6 * 60 * MIN);
    expect(r.netPnl).toBeLessThan(0);
  });

  it('the gated Asia strangle waits up to 2h for the gate and enters the first time it passes', () => {
    const entry = runWindow('ASIA_SHORT', '2026-01-03').entryAtMs;
    const flat = dataFrom(() => 80_000);
    const lateGo = (opens: number): ReplayData => ({ ...flat, dvolAt: (t) => (t < entry + opens * MIN ? 70 : 45) });
    const r = replayRun(lateGo(35), 'ASIA_SHORT', '2026-01-03', 'gated')!;
    expect(r).not.toBeNull();
    expect(r.entryMs).toBe(entry + 35 * MIN);
    // the exit clock never moves, so a late entry just holds for less time
    expect(r.exitMs).toBeLessThanOrEqual(runWindow('ASIA_SHORT', '2026-01-03').exitAtMs);
    // the always book is unaffected and enters on time
    expect(replayRun(lateGo(35), 'ASIA_SHORT', '2026-01-03', 'always')!.entryMs).toBe(entry);
    // a gate that opens after the 2h window never trades; the New York window is 3h
    expect(replayRun(lateGo(125), 'ASIA_SHORT', '2026-01-03', 'gated')).toBeNull();
    const nyEntry = runWindow('NY_SHORT', '2026-01-03').entryAtMs;
    const nyLate: ReplayData = { ...flat, dvolAt: (t) => (t < nyEntry + 150 * MIN ? 70 : 45) };
    expect(replayRun(nyLate, 'NY_SHORT', '2026-01-03', 'gated')!.entryMs).toBe(nyEntry + 150 * MIN);
  });

  it('long straddles never wait: no entry at their time means no trade', () => {
    const entry = runWindow('EVE_LONG', '2026-01-03').entryAtMs;
    const noBarsAtEntry = dataFrom(() => 80_000, { from: entry + 30 * MIN, to: Date.parse('2026-01-06T00:00:00Z') });
    expect(replayRun(noBarsAtEntry, 'EVE_LONG', '2026-01-03', 'always')).toBeNull();
  });

  it('long straddle goes long both legs of the same ATM strike on the next expiry', () => {
    const r = replayRun(dataFrom(() => 80_100), 'EVE_LONG', '2026-01-03', 'always')!;
    expect(r.legs.map((l) => `${l.side}:${l.type}:${l.strike}`)).toEqual(['long:call:80000', 'long:put:80000']);
  });

  it('gated book skips when DVOL is at or above the limit, always book does not', () => {
    const hi = dataFrom(() => 80_000, { dvol: 70 });
    expect(replayRun(hi, 'ASIA_SHORT', '2026-01-03', 'gated')).toBeNull();
    expect(replayRun(hi, 'ASIA_SHORT', '2026-01-03', 'always')).not.toBeNull();
  });

  it('returns null without IV or without bars', () => {
    expect(replayRun(dataFrom(() => 80_000, { iv: null, dvol: null }), 'ASIA_SHORT', '2026-01-03', 'always')).toBeNull();
    expect(replayRun(dataFrom(() => 80_000, { from: Date.parse('2026-01-05T00:00:00Z'), to: Date.parse('2026-01-06T00:00:00Z') }), 'ASIA_SHORT', '2026-01-03', 'always')).toBeNull();
  });

  it('a wider modelled spread lowers the result', () => {
    const d = dataFrom(() => 80_000);
    const base = replayRun(d, 'ASIA_SHORT', '2026-01-03', 'always')!;
    const wide = replayRun(d, 'ASIA_SHORT', '2026-01-03', 'always', { ...DEFAULT_REPLAY, halfSpreadPct: 0.05 })!;
    expect(wide.netPnl).toBeLessThan(base.netPnl);
  });
});

describe('replayAll', () => {
  it('runs every strategy per day, gated only for the short books', () => {
    const d = dataFrom(() => 80_000, { from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-01-09T00:00:00Z') });
    const { runs } = replayAll(d, { fromDate: '2026-01-04', toDate: '2026-01-04' });
    const keys = runs.map((r) => `${r.strategy}|${r.book}`).sort();
    expect(keys).toEqual([
      'ASIA_SHORT|always', 'ASIA_SHORT|gated', 'EVE_LONG|always', 'NY_SHORT|always', 'NY_SHORT|gated', 'PRE_LONG|always',
    ]);
  });
});

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    strategy: 'S', book: 'always', dateKey: '2026-01-05', weekday: 1, entryMs: 0, exitMs: 1, entryIv: 40, dvol: 45, gateGo: true,
    marginUsd: 100, feesUsd: 1, netPnl: 0, exitReason: 'time', peakPnl: 0, troughPnl: 0, path: [[0, 0], [60, 0]], ...over,
  };
}

describe('analytics', () => {
  it('computes win rate, stop/tp rates, drawdown and give-back', () => {
    const runs = [
      rec({ netPnl: 10, exitReason: 'tp', peakPnl: 12, exitMs: 1 }),
      rec({ netPnl: -20, exitReason: 'stop', peakPnl: 3, exitMs: 2 }),
      rec({ netPnl: 5, exitReason: 'time', peakPnl: 5, exitMs: 3 }),
    ];
    const g = groupStats('x', runs);
    expect(g.trades).toBe(3);
    expect(g.netPnl).toBe(-5);
    expect(g.winRate).toBeCloseTo(2 / 3, 9);
    expect(g.stopRate).toBeCloseTo(1 / 3, 9);
    expect(g.tpRate).toBeCloseTo(1 / 3, 9);
    expect(g.maxDrawdown).toBe(20); // peak equity 10, trough -10
    expect(g.avgGiveBack).toBeCloseTo((2 + 23 + 0) / 3, 9);
    expect(g.worstTrade).toBe(-20);
    expect(g.avgWin).toBeCloseTo(7.5, 9);
    expect(g.avgLoss).toBe(-20);
  });

  it('counts both option take-profits (tp) and futures targets (target) as take-profit exits', () => {
    const g = groupStats('x', [rec({ exitReason: 'tp' }), rec({ exitReason: 'target' }), rec({ exitReason: 'stop' }), rec({ exitReason: 'trail' })]);
    expect(g.tpRate).toBeCloseTo(0.5, 9);
    expect(g.stopRate).toBeCloseTo(0.25, 9);
  });

  it('buckets IV and finds the Monday of a week', () => {
    expect(ivBand(29)).toBe('<30');
    expect(ivBand(45)).toBe('40-50');
    expect(ivBand(80)).toBe('60+');
    expect(ivBand(null)).toBe('n/a');
    expect(weekKey('2026-01-07')).toBe('2026-01-05'); // Wednesday -> Monday
    expect(weekKey('2026-01-04')).toBe('2025-12-29'); // Sunday belongs to the prior Monday
  });

  it('exit grid reads the PnL path at a fixed offset, holding the last value after exit', () => {
    const runs = [
      rec({ netPnl: -5, path: [[0, 0], [60, 8], [120, -5]] }),
      rec({ netPnl: 4, path: [[0, 0], [60, 2], [120, 4]] }),
    ];
    const g = exitGrid(runs, [60, 120, 600])[0]!;
    expect(g.points[0]).toMatchObject({ offsetMin: 60, avgPnl: 5, winRate: 1 });
    expect(g.points[1]!.avgPnl).toBeCloseTo(-0.5, 9);
    expect(g.points[2]!.avgPnl).toBeCloseTo(-0.5, 9); // clamped to the final value
    expect(g.actual).toBeCloseTo(-0.5, 9);
  });

  it('buildAnalytics returns every breakdown the page needs', () => {
    const a = buildAnalytics([rec({ netPnl: 3 }), rec({ netPnl: -1, weekday: 2, dateKey: '2026-02-03' })]);
    expect(a.byStrategy[0]!.key).toBe('S|always');
    expect(a.byWeekday.map((g) => g.key)).toEqual(['S|always|Mon', 'S|always|Tue']);
    expect(a.byMonth).toHaveLength(2);
    expect(a.curves[0]!.points[0]).toEqual([0, 0, 0]);
    expect(a.totals.trades).toBe(2);
  });
});
