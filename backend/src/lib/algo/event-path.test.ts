import { describe, expect, it } from 'vitest';
import { describeEvents, eventsInPath, istStamp } from './event-path.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0); // 17:30 IST
const H = 3_600_000;
const ev = (title: string, hoursFromNow: number, over: Record<string, string> = {}) => ({ title, country: 'USD', impact: 'High', date: new Date(NOW + hoursFromNow * H).toISOString(), ...over });

describe('eventsInPath: which news releases fall in the path of a trade', () => {
  const until = NOW + 8 * H; // the planned exit

  it('finds a US High or Medium impact release between the entry and the exit', () => {
    const r = eventsInPath([ev('US CPI', 3), ev('US Retail Sales', 5, { impact: 'Medium' })], NOW, until);
    expect(r.map((e) => e.title)).toEqual(['US CPI', 'US Retail Sales']);
    expect(r[0]).toMatchObject({ impact: 'High' });
  });

  it('ignores a release after the exit, and one long before the entry', () => {
    expect(eventsInPath([ev('Later', 9), ev('Long ago', -3)], NOW, until)).toEqual([]);
  });

  it('counts a release just before the entry (the aftershock is still running) but not one an hour before', () => {
    expect(eventsInPath([ev('Just out', -0.25)], NOW, until).map((e) => e.title)).toEqual(['Just out']);
    expect(eventsInPath([ev('An hour ago', -1)], NOW, until)).toEqual([]);
  });

  it('counts a release at the very moment of the exit', () => {
    expect(eventsInPath([ev('At the exit', 8)], NOW, until)).toHaveLength(1);
  });

  it('ignores other countries, Low impact, holidays, and entries without a usable date', () => {
    const r = eventsInPath([
      ev('Bank of England', 2, { country: 'GBP' }), ev('Minor US data', 2, { impact: 'Low' }), ev('Bank holiday', 2, { impact: 'Holiday' }),
      { title: 'No date', country: 'USD', impact: 'High' }, ev('Bad date', 2, { date: 'not a date' }),
    ], NOW, until);
    expect(r).toEqual([]);
  });

  it('lists them in time order, whatever order the calendar gives', () => {
    expect(eventsInPath([ev('Second', 6), ev('First', 1), ev('Third', 7)], NOW, until).map((e) => e.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('copes with an empty calendar', () => {
    expect(eventsInPath([], NOW, until)).toEqual([]);
  });
});

describe('describing events for the screen', () => {
  it('shows each in IST', () => {
    expect(istStamp(Date.UTC(2026, 9, 27, 12, 30))).toBe('27 Oct 18:00 IST');
    expect(istStamp(Date.UTC(2026, 11, 31, 20, 0))).toBe('1 Jan 01:30 IST');
  });
  it('names the first three and counts the rest', () => {
    const evs = eventsInPath([ev('A', 1), ev('B', 2), ev('C', 3), ev('D', 4), ev('E', 5)], NOW, NOW + 8 * H);
    const text = describeEvents(evs);
    expect(text).toContain('A (High) at');
    expect(text).toContain('C (High) at');
    expect(text).not.toContain('D (High)');
    expect(text).toMatch(/and 2 more$/);
  });
});
