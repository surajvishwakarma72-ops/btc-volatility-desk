import { describe, expect, it } from 'vitest';
import { edgeEstimate, evalConditions, rvPct, type MarketView } from './conditions.js';
import { clockIv, istMinuteOfDay, latest, valueAgo, type Sample } from './series-math.js';
import { defaultStrangle, strategySchema } from './rule.js';
import { istMidnightMs } from '../bot/schedule.js';
import type { Bar } from '../bot/futures.js';

const NOW = Date.parse('2026-10-26T17:00:00Z'); // 22:30 IST
const min = (m: number) => m * 60_000;
const view = (o: Partial<MarketView> = {}): MarketView => ({ spot: 100_000, dvol: 50, gateGo: true, gateReasons: [], premium: 30, bars5m: [], atmIv: 45, nowMs: NOW, ...o });
const smp = (minAgo: number, atmIv: number | null, dvol: number | null): Sample => ({ t: NOW - min(minAgo), atmIv, dvol, spot: null });

// a 5 minute series whose swings shrink or grow with `vol`
function bars(n: number, vol: (i: number) => number, seed = 5): Bar[] {
  let x = seed, p = 100_000;
  const rnd = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 - 0.5; };
  return Array.from({ length: n }, (_, i) => { const o = p; p = p * (1 + rnd() * vol(i)); return { t: NOW - (n - i) * min(5), o, h: Math.max(o, p), l: Math.min(o, p), c: p, v: 1 }; });
}

describe('series helpers', () => {
  it('value some minutes ago, only if a sample is close to that time', () => {
    const h = [smp(60, 50, 52), smp(31, 49, 51), smp(1, 47, 49)];
    expect(valueAgo(h, 'atmIv', NOW, 30)).toBe(49);
    expect(valueAgo(h, 'dvol', NOW, 60)).toBe(52);
    expect(valueAgo(h, 'atmIv', NOW, 300)).toBeNull(); // nothing near 5 hours ago
    expect(latest(h, 'atmIv')).toBe(47);
    expect(latest([smp(1, null, 49)], 'atmIv')).toBeNull();
  });
  it('minute of the IST day', () => {
    expect(istMinuteOfDay(NOW)).toBe(22 * 60 + 30);
    expect(istMinuteOfDay(istMidnightMs('2026-10-26'))).toBe(0);
  });
  it('clock IV averages the same IST time on earlier days, ATM IV first and DVOL when ATM IV is too young', () => {
    const rows: Sample[] = [];
    for (let d = 1; d <= 4; d++) rows.push({ t: NOW - d * 86_400_000 + min(3), atmIv: 40 + d, dvol: 50 + d, spot: null });
    rows.push({ t: NOW - min(2), atmIv: 99, dvol: 99, spot: null }); // today does not count
    const c = clockIv(rows, NOW)!;
    expect(c).toMatchObject({ source: 'ATM IV', days: 4 });
    expect(c.value).toBeCloseTo(42.5);
    const young = clockIv(rows.map((r) => ({ ...r, atmIv: r.t < NOW - 2 * 86_400_000 ? null : r.atmIv })), NOW)!;
    expect(young.source).toBe('DVOL');
    expect(young.value).toBeCloseTo(52.5);
    expect(clockIv([], NOW)).toBeNull();
    expect(clockIv([{ t: NOW - 86_400_000, atmIv: null, dvol: 50, spot: null }], NOW)).toBeNull(); // one day of DVOL is not a pattern
  });
});

describe('falling conditions', () => {
  it('ATM IV and DVOL falling over a time, by at least a drop', () => {
    const h = [smp(60, 48, 55), smp(30, 47, 54), smp(1, 46, 52)];
    const ok = evalConditions([{ type: 'atmiv_falling', minutes: 30, minDrop: 0.5 }, { type: 'dvol_falling', minutes: 60, minDrop: 1 }], view({ hist: h, dvol: 52 }));
    expect(ok.met).toBe(true);
    expect(evalConditions([{ type: 'atmiv_falling', minutes: 30, minDrop: 5 }], view({ hist: h })).met).toBe(false);
    const rising = [smp(30, 40, 50), smp(1, 44, 53)];
    expect(evalConditions([{ type: 'atmiv_falling', minutes: 30 }], view({ hist: rising })).met).toBe(false);
  });
  it('no history yet is a plain no, with the reason', () => {
    const r = evalConditions([{ type: 'atmiv_falling', minutes: 30 }], view({ hist: [smp(1, 46, 50)] }));
    expect(r.met).toBe(false);
    expect(r.results[0]!.now).toMatch(/no 30 min history/);
    expect(evalConditions([{ type: 'dvol_falling', minutes: 30 }], view({ hist: [] , dvol: null })).results[0]!.now).toBe('no data');
  });
  it('RV falling: the last window is calmer than the one before', () => {
    const calming = bars(300, (i) => (i < 288 ? 0.006 : 0.0008));
    const heating = bars(300, (i) => (i < 288 ? 0.0008 : 0.006));
    expect(evalConditions([{ type: 'rv_falling', minutes: 60 }], view({ bars5m: calming })).met).toBe(true);
    expect(evalConditions([{ type: 'rv_falling', minutes: 60 }], view({ bars5m: heating })).met).toBe(false);
    expect(evalConditions([{ type: 'rv_falling' }], view({ bars5m: [] })).results[0]!.now).toBe('no data');
    expect(rvPct(calming, 12)!).toBeLessThan(rvPct(calming, 12, 12)!);
  });
  it('RSI falling over a few bars', () => {
    const down = bars(200, () => 0.0005).map((b, i) => ({ ...b, c: 100_000 - i * 3, o: 100_000 - i * 3 }));
    const up = down.map((b, i) => ({ ...b, c: 100_000 + i * 3, o: 100_000 + i * 3 }));
    // a straight line has RSI at the extreme either way, so use a bend: up then down for the last 20 bars
    const bend = Array.from({ length: 200 }, (_, i) => { const c = i < 180 ? 100_000 + i * 5 : 100_000 + 180 * 5 - (i - 180) * 12; return { t: NOW - (200 - i) * min(5), o: c, h: c, l: c, c, v: 1 }; });
    expect(evalConditions([{ type: 'rsi_falling', tf: '5m', bars: 3, minDrop: 1 }], view({ bars5m: bend })).met).toBe(true);
    expect(evalConditions([{ type: 'rsi_falling', tf: '5m', bars: 3, minDrop: 1 }], view({ bars5m: bars(200, () => 0.0004).map((b, i) => ({ ...b, c: 100_000 + i * 5 + (i > 190 ? (i - 190) * 20 : 0) })) })).met).toBe(false);
    void down; void up;
  });
  it('ADX below a level and falling', () => {
    // a strong trend that flattens into a range: ADX rises then falls
    const path = Array.from({ length: 260 }, (_, i) => { const c = i < 120 ? 100_000 + i * 40 : 100_000 + 120 * 40 + Math.sin(i / 3) * 30; return { t: NOW - (260 - i) * min(5), o: c, h: c + 15, l: c - 15, c, v: 1 }; });
    const r = evalConditions([{ type: 'adx_falling', tf: '5m', value: 60, bars: 3 }], view({ bars5m: path }));
    expect(r.results[0]!.now).toMatch(/ADX/);
    expect(evalConditions([{ type: 'adx_falling', tf: '5m', value: 1, bars: 3 }], view({ bars5m: path })).met).toBe(false); // never below 1
    expect(evalConditions([{ type: 'adx_falling', tf: '5m', value: 60 }], view({ bars5m: [] })).results[0]!.now).toBe('no data');
  });
});

describe('tonight IV vs clock', () => {
  const clk = { value: 42, source: 'ATM IV' as const, days: 5 };
  it('above (rich) and below (cheap), by a number of points', () => {
    expect(evalConditions([{ type: 'ivclock', op: 'above', points: 2 }], view({ clock: clk, atmIv: 45 })).met).toBe(true);
    expect(evalConditions([{ type: 'ivclock', op: 'above', points: 4 }], view({ clock: clk, atmIv: 45 })).met).toBe(false);
    expect(evalConditions([{ type: 'ivclock', op: 'below', points: 2 }], view({ clock: clk, atmIv: 39 })).met).toBe(true);
    expect(evalConditions([{ type: 'ivclock', op: 'below', points: 2 }], view({ clock: clk, atmIv: 45 })).met).toBe(false);
  });
  it('says which series it used and how many days it saw', () => {
    const r = evalConditions([{ type: 'ivclock', op: 'above', points: 0 }], view({ clock: { value: 50, source: 'DVOL', days: 9 }, dvol: 53 }));
    expect(r.results[0]!.now).toBe('DVOL +3.0 vs usual 50.0 (9 days)');
    expect(evalConditions([{ type: 'ivclock', op: 'above', points: 0 }], view({ clock: null })).results[0]!.now).toBe('no clock history yet');
  });
});

describe('edge between', () => {
  const b = bars(1500, () => 0.0012); // about 0.12% a bar: a fairly low realised vol
  it('is ATM IV minus the expected realised vol, and passes when it is inside the range', () => {
    const e = edgeEstimate(b, 45)!;
    expect(e.expected).toBeGreaterThan(0);
    expect(e.edge).toBeCloseTo(45 - e.expected);
    const lo = Math.floor(e.edge) - 1, hi = Math.ceil(e.edge) + 1;
    expect(evalConditions([{ type: 'edge', low: lo, high: hi }], view({ bars5m: b, atmIv: 45 })).met).toBe(true);
    expect(evalConditions([{ type: 'edge', low: hi + 5, high: hi + 10 }], view({ bars5m: b, atmIv: 45 })).met).toBe(false);
  });
  it('needs enough candles and an ATM IV', () => {
    expect(edgeEstimate(bars(100, () => 0.001), 45)).toBeNull();
    expect(edgeEstimate(b, null)).toBeNull();
    expect(evalConditions([{ type: 'edge', low: 0, high: 5 }], view({ bars5m: [] })).results[0]!.now).toBe('no data');
  });
});

describe('the new conditions validate in a rule', () => {
  it('all of them, and a reversed edge range is refused', () => {
    const conds = [{ type: 'adx_falling', tf: '15m', value: 25, bars: 3 }, { type: 'atmiv_falling', minutes: 30, minDrop: 0.3 }, { type: 'dvol_falling', minutes: 60 }, { type: 'rsi_falling', tf: '15m' }, { type: 'rv_falling', minutes: 60 }, { type: 'ivclock', op: 'above', points: 1 }, { type: 'edge', low: 1, high: 6 }];
    const mk = (c: unknown[]) => strategySchema.safeParse(defaultStrangle({ entry: { kind: 'window', from: '22:30', to: '01:30', conditions: c as never } }));
    expect(mk(conds).success).toBe(true);
    expect(mk([{ type: 'edge', low: 6, high: 1 }]).success).toBe(false);
  });
});
