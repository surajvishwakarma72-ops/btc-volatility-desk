import { describe, expect, it } from 'vitest';
import { clockChanges, easter, fmtIst, holidays, nthWeekday, istAt } from './time.js';
import { calendarSize, expectedNfp, rateWeek, sessionsFor, tonight, weekStart, type Release } from './tonight.js';

const ist = (iso: string) => Date.parse(iso + '+05:30');
const hm = (ms: number) => fmtIst(ms);

describe('sessions follow daylight saving (IST)', () => {
  it('winter (2 Nov 2026): London 13:30, NY open 20:00, data 19:00, entry 22:30-23:30', () => {
    const s = sessionsFor(ist('2026-11-02T12:00:00'));
    expect([hm(s.london[0]), hm(s.ny[0]), hm(s.nyOpen), hm(s.usData), hm(s.deltaSettle)]).toEqual(['13:30', '19:30', '20:00', '19:00', '17:30']);
    expect([hm(s.entry[0]), hm(s.entry[1])]).toEqual(['22:30', '23:30']);
    expect(hm(s.fomc)).toBe('00:30');
    expect(s.usSummer).toBe(false);
  });
  it('summer (1 Jul 2026): London 12:30, NY open 19:00, data 18:00, entry 21:30-22:30', () => {
    const s = sessionsFor(ist('2026-07-01T12:00:00'));
    expect([hm(s.london[0]), hm(s.nyOpen), hm(s.usData), hm(s.entry[0])]).toEqual(['12:30', '19:00', '18:00', '21:30']);
    expect(s.usSummer && s.ukSummer).toBe(true);
  });
  it('US moved, UK not (20 Mar 2027): London 13:30, NY open 19:00', () => {
    const s = sessionsFor(ist('2027-03-20T12:00:00'));
    expect([hm(s.london[0]), hm(s.nyOpen)]).toEqual(['13:30', '19:00']);
  });
  it('Deribit settles 13:30 IST on Fridays only', () => {
    expect(hm(sessionsFor(ist('2026-11-06T09:00:00')).deribitSettle!)).toBe('13:30');
    expect(sessionsFor(ist('2026-11-05T09:00:00')).deribitSettle).toBeNull();
  });
});

describe('calendar dates', () => {
  it('holidays, Easter and clock changes', () => {
    expect(easter(2026)).toEqual({ m: 4, d: 5 });
    expect(nthWeekday(2026, 11, 4, 4)).toBe(26); // Thanksgiving
    expect(holidays(2026).get('2026-11-26')).toBe('Thanksgiving (US)');
    expect(clockChanges(2026).map((c) => c.key)).toEqual(['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01']);
  });
  it('expected NFP is the first Friday at 19:00 IST in winter', () => {
    const n = expectedNfp(2026, 11);
    expect(new Date(n.atMs).toISOString()).toBe('2026-11-06T13:30:00.000Z');
  });
});

describe('week ratings', () => {
  const rel: Release[] = [expectedNfp(2026, 11), { title: 'CPI m/m', atMs: Date.parse('2026-11-12T13:30:00Z'), kind: 'CPI' }];
  it('the week of 2 Nov 2026 is Red: US clocks went back and NFP is due', () => {
    const w = rateWeek(weekStart(ist('2026-11-02T12:00:00')), rel);
    expect(w.rating).toBe('Red');
    expect(w.reasons.join(' ')).toContain('clock-change');
    expect(w.events.map((e) => e.label)).toContain('NFP (expected)');
  });
  it('the CPI week of 9 Nov is Amber', () => {
    expect(rateWeek(weekStart(ist('2026-11-10T12:00:00')), rel).rating).toBe('Amber');
  });
  it('a mid-month week without a published CPI date is not shown as clear', () => {
    const w = rateWeek(weekStart(ist('2026-11-10T12:00:00')), [expectedNfp(2026, 11)]);
    expect(w.rating).toBe('Amber');
    expect(w.reasons.join(' ')).toContain('CPI (date not published yet)');
  });
  it('Thanksgiving week is Red (holiday-thin)', () => {
    expect(rateWeek(weekStart(ist('2026-11-24T12:00:00')), rel).rating).toBe('Red');
  });
});

describe('calendar sizing', () => {
  it('Mon 2 Nov 2026 at 23:00: Nov 0.5 × W1 0.75 × Mon after NY open 0.75', () => {
    const c = calendarSize(ist('2026-11-02T23:00:00'), []);
    expect([c.month, c.week, c.day]).toEqual([0.5, 0.75, 0.75]);
    expect(c.product).toBeCloseTo(0.281, 3);
    expect(c.skip).toBe(false);
  });
  it('a Saturday in October stacks to a skip', () => {
    const c = calendarSize(ist('2026-10-03T23:00:00'), []);
    expect(c.product).toBeLessThan(0.25);
    expect(c.skip).toBe(true);
  });
  it('W2 before CPI is 0.5, after CPI has settled 1.0', () => {
    const cpi: Release[] = [{ title: 'CPI', atMs: ist('2026-07-14T18:00:00'), kind: 'CPI' }];
    expect(calendarSize(ist('2026-07-13T22:00:00'), cpi).week).toBe(0.5);
    expect(calendarSize(ist('2026-07-14T22:00:00'), cpi).week).toBe(1.0);
  });
});

describe('tonight', () => {
  it('an NFP inside the hold means SKIP', () => {
    const t = tonight(ist('2026-11-05T15:00:00'), [expectedNfp(2026, 11)], ist('2026-11-07T17:30:00'));
    expect(t.verdict).toBe('SKIP');
    expect(t.inPath.map((e) => e.label)).toEqual(['NFP (expected)']);
  });
  it('a quiet Tuesday in July with nothing in the hold is CLEAN', () => {
    const t = tonight(ist('2026-07-21T15:00:00'), [], ist('2026-07-23T17:30:00'));
    expect(t.verdict).toBe('CLEAN');
    expect(hm(t.entryMs)).toBe('22:00');
  });
  it('FOMC inside the hold comes from the Fed calendar even without the live feed', () => {
    const t = tonight(ist('2026-12-08T15:00:00'), [], ist('2026-12-10T17:30:00'));
    expect(t.inPath.map((e) => e.label)).toContain('FOMC');
    expect(t.verdict).toBe('SKIP');
  });
  void istAt;
});
