import { describe, expect, it } from 'vitest';
import { greekChanges, momentum, priceChanges, seriesChanges, type MomentumCohort } from './momentum.js';

const GRID = 900_000;
const rising = (n: number) => Array.from({ length: n }, () => 1);
const zigzag = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? -1 : 1));

const row = (i: number, delta: number | null, fut = 100) => ({
  sampled_ms: i * GRID,
  grid_ms: i * GRID,
  fut_price: fut,
  data_ok: true,
  call: { delta, gamma: 0.001, theta: -5, vega: 2 },
  put: { delta: delta === null ? null : -delta, gamma: 0.001, theta: -5, vega: 2 },
});
const cohort = (opened_at: number, rows: unknown[]) => ({ opened_at, rows }) as unknown as MomentumCohort;

describe('momentum', () => {
  it('a straight rise is RSI 100 and a strong up trend', () => {
    const m = momentum(rising(40));
    expect(m.rsi).toBe(100);
    expect(m.adx).toBe(100);
    expect(m.direction).toBe('up');
  });

  it('a straight fall is RSI 0 and a strong down trend', () => {
    const m = momentum(rising(40).map((x) => -x));
    expect(m.rsi).toBe(0);
    expect(m.adx).toBe(100);
    expect(m.direction).toBe('down');
  });

  it('a chop has RSI near 50 and almost no trend', () => {
    const m = momentum(zigzag(60));
    expect(m.rsi).toBeGreaterThan(40);
    expect(m.rsi).toBeLessThan(60);
    expect(m.adx).toBeLessThan(15);
  });

  it('matches a hand-worked Wilder RSI', () => {
    // Seed average gain 1, average loss 0.5 over 2 changes... next gain 2: gain (1*1+2)/2=1.5, loss (0.5*1)/2=0.25, RS 6, RSI 85.71
    const m = momentum([2, -1, 2], 2);
    expect(m.rsi).toBeCloseTo(85.71, 1);
  });

  it('says nothing until there are enough samples, and reports how far along it is', () => {
    const short = momentum(rising(5));
    expect(short).toMatchObject({ rsi: null, adx: null, direction: null, samples: 5, needed: 15 });
    const rsiOnly = momentum(rising(15));
    expect(rsiOnly.rsi).toBe(100);
    expect(rsiOnly.adx).toBeNull();
  });

  it('a flat series is neutral, never a divide-by-zero', () => {
    const m = momentum(new Array(40).fill(0));
    expect(m.rsi).toBe(50);
    expect(m.adx).toBe(0);
    expect(m.direction).toBe('flat');
  });
});

describe('greekChanges', () => {
  it('uses size, so a put delta getting more negative counts as rising', () => {
    const c = cohort(0, [row(0, 0.2), row(1, 0.3)]);
    expect(greekChanges([c], 'put', 'delta')[0]).toBeCloseTo(0.5);
  });

  it('does not treat a new strike as a move: a cohort roll adds no jump', () => {
    const a = cohort(0, [row(0, 0.2), row(1, 0.22)]);
    const b = cohort(GRID * 2, [row(2, 0.5), row(3, 0.55)]);
    const out = greekChanges([a, b], 'call', 'delta');
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0.1);
    expect(out[1]).toBeCloseTo(0.1);
  });

  it('when cohorts overlap, one grid counts once, from the newest cohort', () => {
    const a = cohort(0, [row(0, 0.2), row(1, 0.4)]);
    const b = cohort(1, [row(0, 0.2), row(1, 0.22)]);
    const out = greekChanges([a, b], 'call', 'delta');
    expect(out).toHaveLength(1);
    expect(out[0]).toBeCloseTo(0.1);
  });

  it('skips missing values, bad rows and gaps longer than a few grids', () => {
    const c = cohort(0, [row(0, 0.2), row(1, null), row(2, 0.3), { ...row(3, 0.9), data_ok: false }, row(30, 0.4)]);
    expect(greekChanges([c], 'call', 'delta')).toEqual([]);
  });
});

describe('priceChanges', () => {
  it('reads one price per grid across cohorts, in percent', () => {
    const a = cohort(0, [row(0, 0.2, 100), row(1, 0.2, 101)]);
    const b = cohort(GRID, [row(1, 0.2, 101), row(2, 0.2, 100)]);
    const out = priceChanges([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(-0.990, 2);
  });
});

describe('seriesChanges', () => {
  it('skips nulls and joins across them', () => {
    expect(seriesChanges([10, null, 12, 11])).toEqual([2, -1]);
  });
});
