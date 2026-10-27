import type { RawEvent } from '../macro.js';

/**
 * "Is a news event in the path of this trade?" A live short strangle is skipped when a US release that moves BTC volatility (the desk's own
 * definition in lib/macro.ts: US events of High or Medium impact: CPI, FOMC, jobs and the like) falls between a little before the entry and the
 * planned exit. A release just before the entry counts too, because the aftershock is still running. Pure: a calendar in, the events out.
 */
export interface PathEvent { title: string; impact: 'High' | 'Medium'; timestamp: number }

/** How long before the entry a release still counts: the move after it is not over yet. */
export const EVENT_LOOKBACK_MS = 30 * 60_000;

/** The hold length assumed when a trade has no exit time. */
export const DEFAULT_HOLD_MS = 12 * 3_600_000;

export function eventsInPath(items: readonly RawEvent[], fromMs: number, untilMs: number, lookbackMs = EVENT_LOOKBACK_MS): PathEvent[] {
  const out: PathEvent[] = [];
  for (const it of items) {
    if ((it.country || '').toUpperCase() !== 'USD') continue;
    const impact = it.impact === 'High' || it.impact === 'Medium' ? it.impact : null;
    if (!impact || !it.date) continue;
    const ts = new Date(it.date).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts >= fromMs - lookbackMs && ts <= untilMs) out.push({ title: it.title || 'US release', impact, timestamp: ts });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "27 Oct 18:00 IST" */
export function istStamp(ms: number): string {
  const d = new Date(ms + 5.5 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} IST`;
}

/** "US CPI (High) at 27 Oct 18:00 IST; US FOMC Statement (High) at 28 Oct 00:00 IST" */
export function describeEvents(events: readonly PathEvent[], max = 3): string {
  const shown = events.slice(0, max).map((e) => `${e.title} (${e.impact}) at ${istStamp(e.timestamp)}`);
  return shown.join('; ') + (events.length > max ? `; and ${events.length - max} more` : '');
}
