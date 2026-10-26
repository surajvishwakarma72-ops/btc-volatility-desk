import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The Score page's pure core sits between SCORE-CORE markers in frontend/index.html; these tests run that exact code. */
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '../../../frontend/index.html'), 'utf8');
const a = html.indexOf('// SCORE-CORE-START'), b = html.indexOf('// SCORE-CORE-END');
if (a < 0 || b < 0) throw new Error('SCORE-CORE markers not found');
const C = new Function(`${html.slice(a, b)}\nreturn { weekdayOf, summarize, verdict, dayVerdict, byStrategy, byWeekday, byDay, periodFilter, bestWorst };`)() as any;

type T = { id: string; strategy: string; label: string; dateKey: string; entryMs: number; net: number };
let n = 0;
const tr = (strategy: string, dateKey: string, net: number): T => ({ id: 't' + n++, strategy, label: strategy === 'NY' ? 'New York short' : 'Asia short', dateKey, entryMs: Date.parse(dateKey + 'T10:00:00Z'), net });
// 2026-10-26 is a Monday
const MON = '2026-10-26', TUE = '2026-10-27', FRI = '2026-10-30', MON2 = '2026-11-02', TUE2 = '2026-11-03';

describe('weekday and day grouping', () => {
  it('Monday is 0 and Sunday is 6, from the IST date key', () => {
    expect(C.weekdayOf('2026-10-26')).toBe(0);
    expect(C.weekdayOf('2026-10-30')).toBe(4);
    expect(C.weekdayOf('2026-11-01')).toBe(6);
  });
  it('always gives seven weekdays, empty ones included', () => {
    const w = C.byWeekday([tr('NY', MON, 5)]);
    expect(w.map((x: any) => x.short)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(w[0].stats.n).toBe(1);
    expect(w[1].stats.n).toBe(0);
    expect(w[1].kind).toBe('none');
  });
  it('a day with two trades adds them up, newest day first', () => {
    const d = C.byDay([tr('NY', MON, 5), tr('NY', MON, -2), tr('NY', TUE, 1)]);
    expect(d.map((x: any) => x.dateKey)).toEqual([TUE, MON]);
    expect(d[1]).toMatchObject({ net: 3, wd: 0 });
    expect(d[1].trades).toHaveLength(2);
  });
});

describe('statistics and the plain verdict', () => {
  it('totals, wins, averages and profit factor', () => {
    const s = C.summarize([tr('NY', MON, 10), tr('NY', TUE, -4), tr('NY', FRI, 6)]);
    expect(s).toMatchObject({ n: 3, wins: 2, losses: 1, total: 12, avg: 4, avgWin: 8, avgLoss: 4, profitFactor: 4 });
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.best.net).toBe(10);
    expect(s.worst.net).toBe(-4);
  });
  it('no losses means no profit factor, and an empty list does not divide by zero', () => {
    expect(C.summarize([tr('NY', MON, 1)]).profitFactor).toBeNull();
    expect(C.summarize([])).toMatchObject({ n: 0, total: 0, winRate: 0, avg: 0 });
  });
  it('too few trades is never called good or bad', () => {
    const v = C.verdict(C.summarize([tr('NY', MON, 50), tr('NY', TUE, 40)]));
    expect(v.tag).toBe('few');
    expect(v.text).toMatch(/too few/);
  });
  it('working, weak and losing', () => {
    const mk = (nets: number[]) => C.verdict(C.summarize(nets.map((x, i) => tr('NY', MON, x + i * 0))));
    expect(mk([5, 6, 4, 7, 5, -3]).tag).toBe('working');
    expect(mk([5, -4, 5, -4, 5, -3]).tag).toBe('marginal');
    expect(mk([-5, -6, 4, -7, -5, 3]).tag).toBe('losing');
  });
  it('weekday verdict needs three trades', () => {
    const k = (nets: number[]) => C.dayVerdict(C.summarize(nets.map((x) => tr('NY', MON, x))));
    expect(k([])).toBe('none');
    expect(k([5, 5])).toBe('few');
    expect(k([5, 4, 3])).toBe('good');
    expect(k([-5, -4, 3])).toBe('bad');
  });
});

describe('ranking strategies and naming the best weekday', () => {
  const ts = [
    tr('NY', MON, 8), tr('NY', MON2, 6), tr('NY', TUE, -9), tr('NY', TUE2, -7), tr('NY', FRI, 4),
    tr('ASIA', MON, -3), tr('ASIA', TUE, 2),
  ];
  it('best total first, with the trades of each in time order', () => {
    const g = C.byStrategy(ts);
    expect(g.map((x: any) => x.key)).toEqual(['NY', 'ASIA']);
    expect(g[0].trades.map((x: any) => x.dateKey)).toEqual([MON, TUE, FRI, MON2, TUE2]);
    expect(g[0].stats.total).toBe(2);
    expect(g[1].verdict.tag).toBe('few');
  });
  it('names the best and worst weekday, only from weekdays with two trades', () => {
    const w = C.byWeekday(ts.filter((t) => t.strategy === 'NY'));
    const r = C.bestWorst(w);
    expect(r.best.name).toBe('Monday');
    expect(r.worst.name).toBe('Tuesday');
    expect(r.text).toMatch(/Best weekday: Monday: made \$14\.00, won 2 of 2\./);
    expect(r.text).toMatch(/Worst weekday: Tuesday: lost \$16\.00, won 0 of 2\./);
  });
  it('says so when no weekday has enough trades', () => {
    const r = C.bestWorst(C.byWeekday([tr('NY', MON, 5), tr('NY', TUE, 5)]));
    expect(r.best).toBeNull();
    expect(r.text).toMatch(/Not enough trades/);
  });
  it('the period filter keeps recent trades', () => {
    const now = Date.parse(MON2 + 'T12:00:00Z');
    expect(C.periodFilter(ts, 0, now)).toHaveLength(ts.length);
    expect(C.periodFilter(ts, 7, now).map((t: T) => t.dateKey).sort()).toEqual([TUE, TUE, FRI, MON2, TUE2].sort());
    expect(C.periodFilter(ts, 3, now).map((t: T) => t.dateKey).sort()).toEqual([MON2, TUE2].sort());
  });
});
