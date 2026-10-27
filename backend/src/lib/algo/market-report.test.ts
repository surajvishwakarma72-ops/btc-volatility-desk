import { describe, expect, it } from 'vitest';
import { aggregate, type Bar } from '../bot/futures.js';
import { buildMarketReport, detectPatterns, type ReportInput } from './market-report.js';

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);

/** Deterministic pseudo-random numbers, so a test never flakes. */
function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }

/** Six days of 5 minute candles ending at NOW. `path(i, n)` is the close of candle i of n. */
function bars(path: (i: number, n: number) => number, seed = 7): Bar[] {
  const n = 6 * 288, r = rng(seed), out: Bar[] = [];
  let prev = path(0, n);
  for (let i = 0; i < n; i++) {
    const c = path(i, n), wick = 8 + r() * 10;
    out.push({ t: NOW - (n - i) * 300_000, o: prev, h: Math.max(prev, c) + wick, l: Math.min(prev, c) - wick, c, v: 100 + r() * 50 });
    prev = c;
  }
  return out;
}

const quiet = () => { const r = rng(11); return bars(() => 80_000 + (r() - 0.5) * 120); };
const rally = () => { const r = rng(12); return bars((i, n) => 80_000 + (r() - 0.5) * 120 + Math.max(0, i - (n - 500)) * 9); };
const selloff = () => { const r = rng(13); return bars((i, n) => 80_000 + (r() - 0.5) * 120 - Math.max(0, i - (n - 500)) * 9); };

const input = (b: Bar[], over: Partial<ReportInput> = {}): ReportInput => ({
  nowMs: NOW, spot: b[b.length - 1]?.c ?? 80_000, bars5m: b, atmIv: 60, dvol: 52, gateGo: true, gateReasons: [], hist: [], clock: null,
  atm: { expiryLabel: '28 Oct', hoursLeft: 30, strike: 80_000, iv: 60, gamma: 0.00012, theta: -150, straddle: 1500 },
  legs: [
    { type: 'call', strike: 82_400, delta: 0.12, gamma: 0.00003, iv: 62, price: 60 },
    { type: 'put', strike: 77_600, delta: 0.12, gamma: 0.00003, iv: 64, price: 70 },
  ],
  ...over,
});

describe('market report: the trend call', () => {
  it('calls a quiet range sideways and finds it suitable for a short strangle when the gate is clear and IV is rich', () => {
    const rep = buildMarketReport(input(quiet()));
    expect(rep.trend.label).toBe('sideways');
    expect(rep.recommendation.verdict).toBe('go');
    expect(rep.tiles.length).toBeGreaterThanOrEqual(12);
    expect(rep.counts.calm).toBeGreaterThan(rep.counts.caution);
    expect(rep.summary).toMatch(/sideways/);
  });

  it('a dead-flat market whose tiny gaps happen to lean one way is sideways, never bullish or bearish', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed * 101), b = bars(() => 80_000 + (r() - 0.5) * 120, seed);
      const rep = buildMarketReport(input(b));
      expect(rep.trend.label, 'seed ' + seed).toBe('sideways');
      expect(Math.abs(rep.trend.score), 'seed ' + seed).toBeLessThan(40);
    }
  });

  it('calls a strong rally bullish and does not recommend selling into it', () => {
    const rep = buildMarketReport(input(rally()));
    expect(rep.trend.label).toBe('bullish');
    expect(rep.trend.score).toBeGreaterThan(40);
    expect(rep.recommendation.verdict).not.toBe('go');
    expect(rep.recommendation.reasons.join(' ')).toMatch(/bullish/);
  });

  it('calls a strong sell-off bearish', () => {
    const rep = buildMarketReport(input(selloff()));
    expect(rep.trend.label).toBe('bearish');
    expect(rep.trend.score).toBeLessThan(-40);
    expect(rep.recommendation.verdict).not.toBe('go');
  });
});

describe('market report: the indicators and the verdict', () => {
  it('shows every indicator family as a tile: trend, strength, momentum, volatility, IV and the desk gate', () => {
    const rep = buildMarketReport(input(quiet()));
    const groups = new Set(rep.tiles.map((t) => t.group));
    for (const g of ['trend', 'strength', 'momentum', 'volatility', 'iv', 'gate']) expect(groups.has(g as never), g).toBe(true);
    const ids = rep.tiles.map((t) => t.id);
    for (const id of ['ema15', 'macd15m', 'vwap', 'adx15m', 'rsi15m', 'atr', 'bb15m', 'speed', 'atmiv', 'dvol', 'edge', 'gate']) expect(ids, id).toContain(id);
    for (const t of rep.tiles) { expect(t.value.length).toBeGreaterThan(0); expect(['calm', 'caution', 'neutral']).toContain(t.signal); }
  });

  it('a desk gate that says WAIT blocks a GO and says why', () => {
    const rep = buildMarketReport(input(quiet(), { gateGo: false, gateReasons: ['US data in 40 minutes'] }));
    expect(rep.recommendation.verdict).not.toBe('go');
    expect(rep.recommendation.reasons.join(' ')).toMatch(/US data in 40 minutes/);
  });

  it('avoids a strangle when two hard blockers are on at once: a trend and a WAIT gate', () => {
    const rep = buildMarketReport(input(rally(), { gateGo: false, gateReasons: ['NY open'] }));
    expect(rep.recommendation.verdict).toBe('avoid');
    expect(rep.recommendation.headline).toMatch(/Avoid/);
  });

  it('negative edge (IV below what the market delivers) is a blocker and the drivers text says gamma is winning', () => {
    const rep = buildMarketReport(input(quiet(), { atmIv: 5 }));
    expect(rep.iv.edge!).toBeLessThan(0);
    expect(rep.iv.drivers.now).toMatch(/gamma is winning/);
    expect(rep.recommendation.reasons.join(' ')).toMatch(/Edge is negative/);
  });

  it('rich IV says decay is winning, and explains what ends a strangle at its target or at its stop', () => {
    const rep = buildMarketReport(input(quiet(), { atmIv: 90 }));
    expect(rep.iv.edge!).toBeGreaterThan(3);
    expect(rep.iv.drivers.now).toMatch(/decay is winning/);
    expect(rep.iv.drivers.target.join(' ')).toMatch(/theta/i);
    expect(rep.iv.drivers.stop.join(' ')).toMatch(/gamma/i);
    expect(rep.iv.drivers.stop.join(' ')).toMatch(/IV/);
  });

  it('describes the short legs against the ATM: gamma as a share of ATM gamma, IV against ATM IV, and distance in standard moves', () => {
    const rep = buildMarketReport(input(quiet()));
    expect(rep.iv.legs).toHaveLength(2);
    const call = rep.iv.legs.find((l) => l.type === 'call')!;
    expect(call.gammaPctOfAtm).toBeCloseTo(25, 5);
    expect(call.ivVsAtm).toBeCloseTo(2, 5);
    expect(call.distancePct).toBeGreaterThan(2);
    expect(call.sigmas24h!).toBeGreaterThan(0);
    expect(rep.iv.sigma24hPct!).toBeGreaterThan(rep.iv.sigma4hPct!);
  });

  it('works with little data: no candles gives a clear "not enough data" answer instead of a crash or a guess', () => {
    const rep = buildMarketReport(input([], { spot: 80_000, atmIv: null, dvol: null, atm: null, legs: null }));
    expect(rep.recommendation.verdict).toBe('wait');
    expect(rep.recommendation.reasons.join(' ')).toMatch(/not enough candles/i);
    expect(rep.chart.closes).toHaveLength(0);
  });

  it('the chart carries closes, both EMAs and the Bollinger bands for the same candles', () => {
    const rep = buildMarketReport(input(quiet()));
    const n = rep.chart.closes.length;
    expect(n).toBe(64);
    for (const k of ['ema20', 'ema50', 'upper', 'lower'] as const) expect(rep.chart[k]).toHaveLength(n);
    expect(rep.chart.upper[n - 1]!).toBeGreaterThan(rep.chart.lower[n - 1]!);
  });
});

describe('market report: patterns', () => {
  it('finds a tight range', () => {
    const p = detectPatterns(aggregate(quiet(), 15));
    expect(p.join(' ')).toMatch(/Tight range/);
  });
  it('finds a steady climb and a steady slide', () => {
    expect(detectPatterns(aggregate(rally(), 15)).join(' ')).toMatch(/Steady climb|Breakout up/);
    expect(detectPatterns(aggregate(selloff(), 15)).join(' ')).toMatch(/Steady slide|Breakdown/);
  });
  it('finds a spike candle in the last hour', () => {
    const b = quiet();
    const last = b[b.length - 1]!;
    b[b.length - 1] = { ...last, c: last.o + 900, h: last.o + 950 };
    expect(detectPatterns(aggregate(b, 15)).join(' ')).toMatch(/spike|Breakout/);
  });
  it('says nothing when there is too little history', () => {
    expect(detectPatterns(aggregate(quiet().slice(-60), 15))).toEqual([]);
  });
});
