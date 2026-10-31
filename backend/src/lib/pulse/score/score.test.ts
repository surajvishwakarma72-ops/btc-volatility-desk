import { describe, expect, it } from 'vitest';
import type { StepMetrics } from '../metrics/series.js';
import { linesAt, readings, stepLines, stepScore, type CohortSteps, type LiveContext } from './score.js';

const GRID = 900_000;
const step = (t: number, o: Partial<StepMetrics> = {}): StepMetrics => ({
  grid_ms: t, sampled_ms: t, minutes_since_entry: 30, de_call: 1, de_put: 1, balance_drift: 0.05, heavy_leg: null, dsi: 0.8, net_delta: 0.02,
  iv_call_since_entry: -1, iv_put_since_entry: -1, iv_call_1h: -2, iv_put_1h: -2, expected_move: 1, range_ratio: 0.5, oi_call: 'short_buildup',
  oi_put: 'short_buildup', spread_call: 0.02, spread_put: 0.02, spread_median_call: 0.02, spread_median_put: 0.02, spread_veto: false, exit_cost: 0.02,
  liquidity: 'normal', liquidity_unknown: false, move_vs_breakeven: 0.1, efficiency_ratio: 0.1, speed: {}, spot: 100000, move_norm: 0, delta_speed_call: 0, delta_speed_put: 0,
  gamma_speed_call: 0, gamma_speed_put: 0, ...o,
});
const live = (o: Partial<LiveContext> = {}): LiveContext => ({ gatePass: true, killer: null, termInverted: false, persistence: null, noValidStrikes: false, ...o });
const cohort = (t0: number, n: number, o: Partial<StepMetrics> = {}): CohortSteps => ({ opened_at: t0, steps: Array.from({ length: n }, (_, i) => step(t0 + i * GRID, o)) });
const grids = (t0: number, n: number) => Array.from({ length: n }, (_, i) => t0 + i * GRID);

describe('stepScore', () => {
  it('scores a perfect step 100 and a step with too little data null', () => {
    expect(stepScore(step(0))!.score).toBeCloseTo(100);
    expect(stepScore(step(0, { de_call: null, de_put: null, range_ratio: null, dsi: null, net_delta: null, balance_drift: null, iv_call_1h: null, iv_put_1h: null }))).toBeNull();
  });
});

describe('readings', () => {
  it('gives SELL NOW on a clean tape with the gate passing', () => {
    const r = readings(grids(0, 4), [cohort(0, 4)], live());
    expect(r.at(-1)!.verdict).toBe('SELL NOW');
  });
  it('never sells when the gate is unavailable', () => {
    expect(readings(grids(0, 4), [cohort(0, 4)], live({ gatePass: null })).at(-1)!.verdict).toBe('WAIT');
  });
  it('a hard veto shows AVOID at once and caps confidence at 40', () => {
    const r = readings(grids(0, 4), [cohort(0, 4)], live({ termInverted: true })).at(-1)!;
    expect(r.verdict).toBe('AVOID');
    expect(r.confidence).toBeLessThanOrEqual(40);
    expect(r.vetoes).toContain('Term structure inverted');
  });
  it('shows NO DATA when the newest step is stale', () => {
    expect(readings([3 * 3_600_000], [cohort(0, 4)], live()).at(-1)!.verdict).toBe('NO DATA');
  });
  it('changes zone only after two readings on the new side', () => {
    const bad = { de_call: 0.2, de_put: 0.2, range_ratio: 1.2, dsi: 4, net_delta: 0.4, balance_drift: 0.6, iv_call_1h: 3, iv_put_1h: 3, oi_call: 'long_buildup' as const, oi_put: 'long_buildup' as const, efficiency_ratio: 0.7, move_vs_breakeven: 0.7 };
    const c: CohortSteps = { opened_at: 0, steps: [step(0), step(GRID), step(2 * GRID), step(3 * GRID, bad), step(4 * GRID, bad)] };
    const z = readings(grids(0, 5), [c], null).map((r) => r.zone);
    expect(z[3]).not.toBe('avoid');
    expect(z[4]).toBe('avoid');
  });
});

describe('risk lines', () => {
  it('sit at 0 when everything is calm', () => {
    expect(stepLines(step(0))).toEqual({ call: 0, put: 0, futLong: 0, futShort: 0 });
  });
  it('lift the call line when call IV rises and call delta and gamma speed up', () => {
    const l = stepLines(step(0, { iv_call_1h: 2, delta_speed_call: 0.04, gamma_speed_call: 0.3 }));
    expect(l.call).toBeGreaterThan(50);
    expect(l.put).toBe(0);
  });
  it('lift only the long-futures line on a strong straight up move, and only the short line on a down move', () => {
    const up = stepLines(step(0, { move_norm: 1.2, efficiency_ratio: 0.7 }));
    expect(up.futLong).toBe(100);
    expect(up.futShort).toBe(0);
    const dn = stepLines(step(0, { move_norm: -1.2, efficiency_ratio: 0.7 }));
    expect(dn.futShort).toBe(100);
    expect(dn.futLong).toBe(0);
  });
  it('leave a line null when its inputs are missing, and blend cohorts by recency', () => {
    expect(stepLines(step(0, { move_norm: null })).futLong).toBeNull();
    const calm: CohortSteps = { opened_at: 0, steps: [step(GRID)] };
    const hot: CohortSteps = { opened_at: GRID, steps: [step(GRID, { iv_call_1h: 2, de_call: 0.3, delta_speed_call: 0.04, gamma_speed_call: 0.3, oi_call: 'long_buildup' })] };
    const only = linesAt(GRID, [hot]);
    expect(only.call).toBe(100);
    expect(linesAt(GRID, [calm, hot]).call).toBe(50); // both sit in the newest-three group, so they average
  });
});
