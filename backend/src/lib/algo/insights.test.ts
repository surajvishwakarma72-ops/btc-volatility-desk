import { describe, expect, it } from 'vitest';
import { rankIndicators } from './insights.js';
import type { Bar } from '../bot/futures.js';

// a small deterministic pseudo-random walk
function walk(n: number, drift: number, vol: number, seed = 7): Bar[] {
  let x = seed, p = 100_000;
  const rnd = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 - 0.5; };
  return Array.from({ length: n }, (_, i) => {
    const o = p; p = p * (1 + drift + rnd() * vol);
    return { t: 1_700_000_000_000 + i * 900_000, o, h: Math.max(o, p) * 1.0004, l: Math.min(o, p) * 0.9996, c: p, v: 1 };
  });
}

describe('indicator ranking', () => {
  it('a steady uptrend favours the trend signals and says they are long', () => {
    const r = rankIndicators(walk(1500, 0.0004, 0.002));
    const ema = r.futures.find((f) => f.id === 'ema_9_21')!;
    expect(ema.avgPct).toBeGreaterThan(0);
    expect(ema.winRate).toBeGreaterThan(0.5);
    expect(ema.now).toBe(1);
    const best = r.futures[0]!;
    expect(best.score).toBeGreaterThanOrEqual(r.futures[r.futures.length - 1]!.score);
    expect(r.bars).toBe(1500);
    expect(r.note).toMatch(/in-sample/);
  });

  it('a falling market makes the long-only reading of a signal lose', () => {
    const r = rankIndicators(walk(1500, -0.0004, 0.002));
    const ema = r.futures.find((f) => f.id === 'ema_9_21')!;
    expect(ema.now).toBe(-1);
    expect(ema.avgPct).toBeGreaterThan(0); // the sell signal pays, because the signal is signed
  });

  it('ranks option-selling filters by how much calmer the next 8 hours were, and compares with the average', () => {
    // calm stretch followed by a violent one, repeated: a "low ATR" filter should pick the calm bars
    const bars: Bar[] = [];
    for (let k = 0; k < 6; k++) bars.push(...walk(260, 0, k % 2 === 0 ? 0.0008 : 0.01, 11 + k).map((b, i) => ({ ...b, t: 1_700_000_000_000 + (bars.length + i) * 900_000 })));
    const r = rankIndicators(bars, 20);
    expect(r.options.length).toBeGreaterThan(0);
    const o = r.options[0]!;
    expect(o.baseline).toBeGreaterThan(0);
    expect(o.calmerPct).toBeGreaterThanOrEqual(r.options[r.options.length - 1]!.calmerPct);
    for (const x of r.options) { expect(x.calmRate).toBeGreaterThanOrEqual(0); expect(x.calmRate).toBeLessThanOrEqual(1); }
  });

  it('too little data gives an empty ranking instead of a guess', () => {
    const r = rankIndicators(walk(160, 0, 0.002));
    expect(r.futures).toEqual([]);
    expect(r.options).toEqual([]);
  });
});
