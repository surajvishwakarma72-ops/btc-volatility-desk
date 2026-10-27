import { beforeEach, describe, expect, it } from 'vitest';
import { eventsForTrade, holdEndMs, loadUsEvents, resetEventFeed } from './event-guard.js';
import { defaultStrangle } from '../../lib/algo/rule.js';
import type { EntryPlan } from './algo-engine.js';

const H = 3_600_000;
// 2026-10-27 05:30 IST: a Tuesday morning
const NOW = Date.UTC(2026, 9, 27, 0, 0, 0);
const feed = (title: string, hoursFromNow: number) => ({ title, country: 'USD', impact: 'High', date: new Date(NOW + hoursFromNow * H).toISOString() });

type Week = unknown[] | 'down' | 'missing';
function fetcher(spec: { thisWeek?: Week; nextWeek?: Week } = {}) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const week = url.includes('thisweek') ? spec.thisWeek : spec.nextWeek;
    if (week === 'down') throw new Error('offline');
    if (week === 'missing' || week === undefined) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => week };
  }) as unknown as typeof fetch;
  return { f, calls };
}

beforeEach(() => resetEventFeed());

describe('the news calendar feed', () => {
  it('reads this week and next week, and a missing next-week file is not a failure', async () => {
    const x = fetcher({ thisWeek: [feed('US CPI', 3)], nextWeek: 'missing' });
    const items = await loadUsEvents(NOW, x.f);
    expect(items).toHaveLength(1);
    expect(x.calls).toHaveLength(2);
  });

  it('keeps the answer for 15 minutes instead of asking again', async () => {
    const x = fetcher({ thisWeek: [feed('US CPI', 3)] });
    await loadUsEvents(NOW, x.f);
    await loadUsEvents(NOW + 10 * 60_000, x.f);
    expect(x.calls).toHaveLength(2); // the first read's two calls, nothing more
    await loadUsEvents(NOW + 20 * 60_000, x.f);
    expect(x.calls).toHaveLength(4);
  });

  it('serves the last good copy when the feed goes down, for up to 48 hours', async () => {
    await loadUsEvents(NOW, fetcher({ thisWeek: [feed('US CPI', 3)] }).f);
    expect(await loadUsEvents(NOW + 3 * H, fetcher({ thisWeek: 'down', nextWeek: 'down' }).f)).toHaveLength(1);
    expect(await loadUsEvents(NOW + 49 * H, fetcher({ thisWeek: 'down', nextWeek: 'down' }).f)).toBeNull();
  });

  it('answers "unknown" (null), never "no events", when it has never been able to read the calendar', async () => {
    expect(await loadUsEvents(NOW, fetcher({ thisWeek: 'down', nextWeek: 'down' }).f)).toBeNull();
    resetEventFeed();
    expect(await loadUsEvents(NOW, fetcher({ thisWeek: 'missing', nextWeek: 'missing' }).f)).toBeNull();
  });
});

describe('how long the trade is exposed', () => {
  const plan = (expiryMs: number | undefined): EntryPlan => ({ kind: 'option', legs: [{ symbol: 'C', side: 'sell', lots: 1, bid: 1, ask: 1, delta: 0.1, strike: 1, expiryCode: 'x', type: 'call', expiryMs } as never], expiries: ['x'], spot: 1, premium: 1 });

  it('runs to the exit time', () => {
    const rule = defaultStrangle({ exit: { ...defaultStrangle().exit, exitTime: '13:30' } }); // 08:00 UTC, 8 hours after NOW... 13:30 IST is 08:00 UTC
    expect(holdEndMs(rule, null, NOW)).toBe(NOW + 8 * H);
  });
  it('is 12 hours when the rule has no exit time', () => {
    const rule = defaultStrangle({ exit: { ...defaultStrangle().exit, exitTime: null } });
    expect(holdEndMs(rule, null, NOW)).toBe(NOW + 12 * H);
  });
  it('never runs past the first option expiry', () => {
    const rule = defaultStrangle({ exit: { ...defaultStrangle().exit, exitTime: null } });
    expect(holdEndMs(rule, plan(NOW + 5 * H), NOW)).toBe(NOW + 5 * H);
  });
});

describe('events in the path of a trade', () => {
  const rule = defaultStrangle({ exit: { ...defaultStrangle().exit, exitTime: '13:30' } }); // ends 8 hours after NOW
  it('finds a release inside the hold and ignores one after it', async () => {
    const load = async () => [feed('US CPI', 3), feed('US GDP', 20)];
    const r = await eventsForTrade(rule, null, NOW, load);
    expect(r?.map((e) => e.title)).toEqual(['US CPI']);
  });
  it('an empty path is an empty list, and an unreadable calendar is null', async () => {
    expect(await eventsForTrade(rule, null, NOW, async () => [feed('US GDP', 20)])).toEqual([]);
    expect(await eventsForTrade(rule, null, NOW, async () => null)).toBeNull();
  });
});
