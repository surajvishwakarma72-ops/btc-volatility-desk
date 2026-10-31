/*
 * Parity tests for the server-side port of the desk's regime indicators.
 *
 * The GOLDEN numbers below come from running the BROWSER implementation (adxSeries, returnsOf, rvWindow, dailyRv,
 * dPercentile, regimeCompute, source text extracted from frontend/index.html) at commit 6d50f7d, with Date.now() pinned
 * to the same `nowMs` used here, on the deterministic series built by `makeBars` below (seeded mulberry32). The scratch
 * script that produced them used a byte-for-byte copy of `makeBars`. Values are rounded to 6 decimals.
 */
import { describe, expect, it } from 'vitest';
import {
  adxSeries,
  dailyRv,
  hourReturns,
  ivOverRv,
  percentileBelow,
  regimeState,
  rvWindow,
  type Bar1h,
} from './indicators.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const NOW_OFFSET = 20 * 60_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBars(n: number): Bar1h[] {
  const rnd = mulberry32(12345);
  const bars: Bar1h[] = [];
  let px = 60000;
  for (let i = 0; i < n; i++) {
    const o = px;
    const ret = 0.003 * Math.sin(i / 17) + 0.008 * (rnd() - 0.5) * (1 + 0.6 * Math.sin(i / 300));
    const c = o * Math.exp(ret);
    const h = Math.max(o, c) * (1 + 0.003 * rnd());
    const l = Math.min(o, c) * (1 - 0.003 * rnd());
    bars.push({ t: T0 + i * HOUR, o, h, l, c });
    px = c;
  }
  return bars;
}

const nowFor = (n: number) => T0 + (n - 1) * HOUR + NOW_OFFSET;
const bars400 = makeBars(400);
const barsLong = makeBars(2400);
const NOW_LONG = nowFor(2400);

describe('browser parity (golden values)', () => {
  it('adxSeries last three values and length', () => {
    const a = adxSeries(bars400)!;
    expect(a).toHaveLength(373);
    expect(a.slice(-3).map((x) => x.v)[0]).toBeCloseTo(43.950689, 6);
    expect(a.at(-2)!.v).toBeCloseTo(43.710888, 6);
    expect(a.at(-1)!.v).toBeCloseTo(43.488215, 6);
  });

  it('rvWindow 168h', () => {
    const rets = hourReturns(bars400, NOW_LONG);
    expect(rets).toHaveLength(399);
    expect(rvWindow(rets, rets.at(-1)!.t, 168)).toBeCloseTo(0.393317, 6);
  });

  it('dailyRv length and last value', () => {
    const rets = hourReturns(barsLong, NOW_LONG);
    expect(rets.at(-1)!.h).toBeCloseTo(1 / 3, 9); // forming bar shortened to the 20 minutes elapsed
    const days = dailyRv(rets, NOW_LONG);
    expect(days).toHaveLength(99);
    expect(days.at(-1)!.day).toBe(20552);
    expect(days.at(-1)!.v).toBeCloseTo(0.390336, 6);
    expect(rvWindow(rets, rets.at(-1)!.t, 168)).toBeCloseTo(0.376775, 6);
  });

  it('regimeState matches regimeCompute (ADX rising, RVP falling)', () => {
    const s = regimeState(barsLong, NOW_LONG)!;
    expect(s.rvp).toBeCloseTo(0.731183, 6);
    expect(s.rvpPrev).toBeCloseTo(0.860215, 6);
    expect(s.adx).toBeCloseTo(59.709399, 6);
    expect(s.adxPrev).toBeCloseTo(53.403564, 6);
    expect(s.rv7).toBeCloseTo(0.376775, 6);
    expect(s.rvpUp).toBe(false);
    expect(s.adxUp).toBe(true);
    expect(s.killer).toBe(false);
  });

  it('regimeState matches regimeCompute (both rising gives killer)', () => {
    const bars = makeBars(2428);
    const s = regimeState(bars, nowFor(2428))!;
    expect(s.rvp).toBeCloseTo(0.957895, 6);
    expect(s.rvpPrev).toBeCloseTo(0.715789, 6);
    expect(s.adx).toBeCloseTo(27.189524, 6);
    expect(s.adxPrev).toBeCloseTo(26.224555, 6);
    expect(s.rv7).toBeCloseTo(0.395337, 6);
    expect(s.rvpUp).toBe(true);
    expect(s.adxUp).toBe(true);
    expect(s.killer).toBe(true);
  });
});

describe('adxSeries analytic cases', () => {
  const mk = (cs: number[]): Bar1h[] => cs.map((c, i) => ({ t: T0 + i * HOUR, h: c + 1, l: c - 1, c }));

  it('strictly rising bars give ADX 100', () => {
    const a = adxSeries(mk(Array.from({ length: 60 }, (_, i) => 100 + 2 * i)))!;
    expect(a.at(-1)!.v).toBeGreaterThan(99);
  });
  it('alternating series gives low ADX', () => {
    const a = adxSeries(mk(Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 1 : 0))))!;
    expect(a.at(-1)!.v).toBeLessThan(10);
  });
  it('flat bars give 0', () => {
    const flat: Bar1h[] = Array.from({ length: 60 }, (_, i) => ({ t: T0 + i * HOUR, h: 100, l: 100, c: 100 }));
    expect(adxSeries(flat)!.at(-1)!.v).toBe(0);
  });
  it('too few bars gives null', () => {
    expect(adxSeries(bars400.slice(0, 20))).toBeNull();
  });
});

describe('helpers', () => {
  it('percentileBelow', () => {
    expect(percentileBelow([1, 2, 3, 4], 3)).toBe(0.5);
    expect(percentileBelow([], 1)).toBeNull();
    expect(percentileBelow([1], null)).toBeNull();
  });
  it('ivOverRv', () => {
    expect(ivOverRv(0.65, 0.5)).toBeCloseTo(1.3, 6);
    expect(ivOverRv(0.5, 0)).toBeNull();
    expect(ivOverRv(null, 0.5)).toBeNull();
    expect(ivOverRv(0.5, null)).toBeNull();
  });
  it('a 5-hour hole yields an hour span of 6', () => {
    const ts = [0, 1, 2, 3, 9, 10];
    const bars: Bar1h[] = ts.map((h) => ({ t: T0 + h * HOUR, h: 101, l: 99, c: 100 + h }));
    const rets = hourReturns(bars);
    expect(rets.map((r) => r.h)).toEqual([1, 1, 1, 6, 1]);
  });
  it('regimeState is null on short history', () => {
    expect(regimeState(bars400, nowFor(400))).toBeNull();
  });
});
