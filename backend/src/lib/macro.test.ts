import { describe, expect, it } from 'vitest';
import {
  blendLink, correlationWithBtc, eventFactor, hourlyReturns, MARKET_STALE_MS, pearson, priceNear, readMoves, relevantEvents, stressScore, type Pt,
} from './macro.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const series = (fn: (t: number) => number, from: number, to: number, stepMin = 5): Pt[] => {
  const out: Pt[] = [];
  for (let t = from; t <= to; t += stepMin * 60_000) out.push({ t, p: fn(t) });
  return out;
};

describe('quote freshness and moves', () => {
  it('reads 1h and 4h moves from the right reference prices when the market is trading', () => {
    const pts = series((t) => 100 + (t - (NOW - 5 * 3_600_000)) / 3_600_000, NOW - 5 * 3_600_000, NOW); // +1 per hour
    const m = readMoves(pts, 105, NOW);
    expect(m.open).toBe(true);
    expect(m.change1hPct).toBeCloseTo(((105 - 104) / 104) * 100, 6);
    expect(m.change4hPct).toBeCloseTo(((105 - 101) / 101) * 100, 6);
    expect(m.partial).toBe(false);
  });

  it('treats a market with old candles as closed, not calm, and reports zero moves', () => {
    const pts = series(() => 100, NOW - 30 * 3_600_000, NOW - 2 * 3_600_000);
    const m = readMoves(pts, 100, NOW);
    expect(m.open).toBe(false);
    expect(m.ageMin).toBeGreaterThan(MARKET_STALE_MS / 60_000);
    expect(m.change1hPct).toBe(0);
  });

  it('does not borrow a far-away price as the one-hour reference', () => {
    // candles exist now and 3h ago, nothing around the 1h mark
    const pts: Pt[] = [{ t: NOW - 3 * 3_600_000, p: 90 }, { t: NOW - 600_000, p: 100 }, { t: NOW, p: 100 }];
    expect(priceNear(pts, NOW - 3_600_000, 20 * 60_000)).toBeNull();
    const m = readMoves(pts, 100, NOW);
    expect(m.change1hPct).toBe(0);
    expect(m.partial).toBe(true);
  });
});

describe('link to BTC', () => {
  const h = (n: number) => Date.parse('2026-10-20T00:00:00Z') + n * 3_600_000;
  const mk = (f: (i: number) => number, n = 60): Pt[] => Array.from({ length: n }, (_, i) => ({ t: h(i) + 1000, p: f(i) }));

  it('hourly returns need consecutive hours', () => {
    const r = hourlyReturns([{ t: h(0), p: 100 }, { t: h(1), p: 101 }, { t: h(3), p: 103 }]);
    expect([...r.keys()]).toEqual([Math.floor(h(1) / 3_600_000)]);
  });

  it('measures a strong positive and a strong negative relationship, and refuses to guess on thin data', () => {
    const wave = (i: number) => Math.sin(i * 0.9) + Math.sin(i * 0.37);
    const btc = hourlyReturns(mk((i) => 80_000 * Math.exp(0.01 * wave(i))));
    const same = hourlyReturns(mk((i) => 100 * Math.exp(0.01 * wave(i))));
    const opposite = hourlyReturns(mk((i) => 20 * Math.exp(-0.01 * wave(i))));
    expect(correlationWithBtc(same, btc).corr).toBeGreaterThan(0.95);
    expect(correlationWithBtc(opposite, btc).corr).toBeLessThan(-0.95);
    expect(correlationWithBtc(hourlyReturns(mk((i) => 100 + i, 10)), hourlyReturns(mk((i) => 80_000 + i, 10))).corr).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it('blends the measured strength (sign ignored) half and half with the prior', () => {
    expect(blendLink([0.8, -0.8], 0.2)).toBeCloseTo(0.5, 9);
    expect(blendLink([null, null], 0.36)).toBe(0.36);
    expect(blendLink([0.1], 0.5)).toBeCloseTo(0.3, 9);
  });
});

describe('news calendar', () => {
  const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
  it('ramps up before an event, decays after it, and Medium counts 60%', () => {
    expect(eventFactor(6, 'High')).toBe(0);
    expect(eventFactor(3, 'High')).toBeCloseTo(0.5, 9);
    expect(eventFactor(0, 'High')).toBe(1);
    expect(eventFactor(-1, 'High')).toBeCloseTo(0.5, 9);
    expect(eventFactor(-2.5, 'High')).toBe(0);
    expect(eventFactor(0, 'Medium')).toBeCloseTo(0.6, 9);
  });

  it('keeps only US high and medium impact releases inside the window, nearest first', () => {
    const ev = relevantEvents([
      { title: 'CPI y/y', country: 'USD', impact: 'High', date: at(2) },
      { title: 'Swiss CPI', country: 'CHF', impact: 'High', date: at(1) }, // another country: ignored
      { title: 'Jobless Claims', country: 'USD', impact: 'Medium', date: at(0.5) },
      { title: 'Fed speaker', country: 'USD', impact: 'Low', date: at(1) }, // low impact: ignored
      { title: 'Next week NFP', country: 'USD', impact: 'High', date: at(40) }, // too far
      { title: 'Old release', country: 'USD', impact: 'High', date: at(-5) }, // too old
      { title: 'Bank Holiday', country: 'USD', impact: 'Holiday', date: at(1) },
      { title: 'Broken', country: 'USD', impact: 'High', date: 'nonsense' },
    ], NOW);
    expect(ev.map((e) => e.title)).toEqual(['Jobless Claims', 'CPI y/y']);
    expect(ev[1]!.factor).toBeCloseTo((6 - 2) / 6, 9);
  });
});

describe('score', () => {
  const W = { forex: 0.15, commodities: 0.15, equities: 0.2, bonds: 0.2, event: 0.3 };
  it('quiet markets sit at the floor and an imminent US release alone reads amber, not red', () => {
    expect(stressScore({ press: { forex: 0, commodities: 0, equities: 0, bonds: 0, event: 0 }, weights: W })).toBe(12);
    const eventOnly = stressScore({ press: { forex: 0, commodities: 0, equities: 0, bonds: 0, event: 3.5 }, weights: W }); // factor 1
    expect(eventOnly).toBeGreaterThanOrEqual(35);
    expect(eventOnly).toBeLessThanOrEqual(65);
  });
  it('several markets moving together on top of an event reaches red, and the score is capped', () => {
    const s = stressScore({ press: { forex: 1.2, commodities: 1.2, equities: 2, bonds: 1.5, event: 3.5 }, weights: W });
    expect(s).toBeGreaterThan(65);
    expect(stressScore({ press: { forex: 50, commodities: 50, equities: 50, bonds: 50, event: 50 }, weights: W })).toBe(96);
  });
});
