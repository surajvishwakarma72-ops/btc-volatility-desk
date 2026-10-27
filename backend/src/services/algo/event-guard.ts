import type { RawEvent } from '../../lib/macro.js';
import { DEFAULT_HOLD_MS, eventsInPath, type PathEvent } from '../../lib/algo/event-path.js';
import { exitAtMs, type AlgoStrategy } from '../../lib/algo/rule.js';
import { istDateKey } from '../../lib/bot/schedule.js';
import type { EntryPlan } from './algo-engine.js';

/**
 * The news calendar for the live-entry guard: the same free ForexFactory weekly feed the macro stress reading uses, this week and next,
 * kept for 15 minutes and, if the feed is down, the last good copy for up to 48 hours. When there is no copy at all the answer is
 * "unknown" (null), never "no events": the caller decides what an unknown calendar means.
 */
const FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
const FRESH_MS = 15 * 60_000, STALE_MS = 48 * 3_600_000;
let cache: { at: number; items: RawEvent[] } | null = null;

export function resetEventFeed(): void { cache = null; }

export async function loadUsEvents(now = Date.now(), fetcher: typeof fetch = fetch): Promise<RawEvent[] | null> {
  if (cache && now - cache.at < FRESH_MS) return cache.items;
  try {
    const items: RawEvent[] = [];
    let thisWeekOk = false;
    for (const [i, url] of FEEDS.entries()) {
      try {
        const res = await fetcher(url, { headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.timeout(8_000) });
        if (!res.ok) continue; // next week's file is often missing: that is not a failure
        const j = await res.json();
        if (Array.isArray(j)) { items.push(...(j as RawEvent[])); if (i === 0) thisWeekOk = true; }
      } catch { /* try the other feed */ }
    }
    if (thisWeekOk) { cache = { at: now, items }; return items; }
  } catch { /* fall through to the stale copy */ }
  return cache && now - cache.at < STALE_MS ? cache.items : null;
}

/** When the trade would end: its exit time, never later than the first option expiry, or 12 hours when it has none. */
export function holdEndMs(rule: AlgoStrategy, plan: EntryPlan | null, now: number): number {
  const exit = exitAtMs(rule.exit, { dateKey: istDateKey(now), startMs: now, endMs: now }, now) ?? now + DEFAULT_HOLD_MS;
  const expiries = plan?.kind === 'option' ? plan.legs.map((l) => l.expiryMs).filter((x): x is number => typeof x === 'number' && x > now) : [];
  return expiries.length ? Math.min(exit, ...expiries) : exit;
}

/** The events in the path of this trade, or null when the calendar cannot be read. */
export async function eventsForTrade(rule: AlgoStrategy, plan: EntryPlan | null, now = Date.now(), load: typeof loadUsEvents = loadUsEvents): Promise<PathEvent[] | null> {
  const items = await load(now);
  return items ? eventsInPath(items, now, holdEndMs(rule, plan, now)) : null;
}
