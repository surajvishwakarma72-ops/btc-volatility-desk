import { describe, expect, it } from 'vitest';
import { replayFutures } from './futures-replay.js';
import { aggregate, type Bar } from './futures.js';

const MIN = 60_000;

/**
 * Winter day 2026-12-02: Asia 05:30-13:30 IST (00:00-08:00 UTC), London opens 08:00 UTC.
 * Quiet Asia range, a London sweep of the Asia high that reclaims, then `after(minutesSinceSweep)`.
 */
function scenario(after: (m: number) => number, o: { volume?: number } = {}): Bar[] {
  const start = Date.parse('2026-12-01T20:00:00Z');
  const end = Date.parse('2026-12-02T20:00:00Z');
  const sweepAt = Date.parse('2026-12-02T08:25:00Z');
  const bars: Bar[] = [];
  for (let t = start; t < end; t += MIN) {
    let o_ = 80_000 + Math.sin(t / 900_000) * 60;
    let h = Math.min(o_ + 15, 80_100);
    let l = Math.max(o_ - 15, 79_900);
    let c = o_ + 2;
    let v = 100;
    const m = (t - sweepAt) / MIN;
    if (m >= 0 && m < 5) {
      o_ = 80_090; h = m === 2 ? 80_260 : 80_105; l = 80_070; c = m === 4 ? 80_040 : 80_095; v = o.volume ?? 400;
    } else if (m >= 5) {
      const p = after(m - 5);
      o_ = p; h = p + 8; l = p - 8; c = p; v = 100;
    }
    bars.push({ t, o: o_, h, l, c, v });
  }
  return bars;
}

describe('replayFutures', () => {
  it('a London sweep of the Asia high that reclaims and then falls ends at target as a SHORT', () => {
    const bars = scenario((m) => 80_040 - m * 6);
    const { runs } = replayFutures(bars, { strategies: ['FUT_SWEEP_LDN'] });
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.dir).toBe('short');
    expect(r.exitReason).toBe('target');
    expect(r.netPnl).toBeGreaterThan(0);
    expect(r.entry).toBeLessThan(80_040);
    expect(r.stop).toBeGreaterThan(80_260);
    expect(r.lots).toBeLessThanOrEqual(25);
    expect(r.confirmations.length).toBeGreaterThanOrEqual(2);
    expect(r.path[0]![0]).toBe(0);
    expect(r.path[r.path.length - 1]![0]).toBeGreaterThan(0);
    expect(r.feesUsd).toBeGreaterThan(0);
    expect(r.strategy).toBe('FUT_SWEEP_LDN');
  });

  it('the same sweep followed by a rally stops the short out for roughly the risked amount', () => {
    const bars = scenario((m) => 80_040 + m * 6);
    const { runs } = replayFutures(bars, { strategies: ['FUT_SWEEP_LDN'] });
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.exitReason).toBe('stop');
    expect(r.netPnl).toBeLessThan(0);
    expect(Math.abs(r.netPnl)).toBeLessThan(5 + 3); // risk 5 USD + fees and slippage
  });

  it('takes only one trade per session even if price keeps sweeping', () => {
    const bars = scenario((m) => (m < 20 ? 80_040 : 80_040 - (m - 20) * 6));
    const { runs } = replayFutures(bars, { strategies: ['FUT_SWEEP_LDN'] });
    expect(runs.length).toBeLessThanOrEqual(1);
  });

  it('does nothing when the confirmations are not met', () => {
    const bars = scenario((m) => 80_040 - m * 6, { volume: 100 });
    const { runs } = replayFutures(bars, { strategies: ['FUT_SWEEP_LDN'], cfg: { minConfirm: 4 } });
    expect(runs).toHaveLength(0);
  });

  it('reports plan rejections (fee or stop width) instead of trading them', () => {
    const bars = scenario((m) => 80_040 - m * 6);
    const { runs, skippedByPlan, signals } = replayFutures(bars, { strategies: ['FUT_SWEEP_LDN'], cfg: { maxFeeToRisk: 0.01 } });
    expect(runs).toHaveLength(0);
    expect(signals).toBe(1);
    expect(Object.keys(skippedByPlan).join()).toMatch(/fee/);
  });

  it('closes a trade still open when the data ends', () => {
    const bars = scenario((m) => 80_040 - m * 0.1).filter((b) => b.t < Date.parse('2026-12-02T08:50:00Z'));
    const { runs } = replayFutures(bars, { strategies: ['FUT_SWEEP_LDN'] });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.exitReason).toBe('time');
  });

  it('aggregate sanity: the scenario builds contiguous 1m bars', () => {
    const bars = scenario(() => 80_000);
    expect(aggregate(bars, 5).length).toBeGreaterThan(280);
    expect(new Set(bars.map((b) => b.t)).size).toBe(bars.length);
  });
});
