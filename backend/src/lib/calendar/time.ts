/**
 * Market clock in IST, computed from London and New York local time (IANA zones), so every session and release time
 * follows daylight saving on its own. Plus the holiday, clock-change and expiry dates the week ratings need.
 */

export const H = 3_600_000;
export const DAY = 24 * H;
export const IST_MS = 5.5 * H;

/** Offset of `tz` from UTC at instant `ms`, in ms (e.g. New York in winter = -5 h). */
export function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in `tz` (y, month 1-12, d, h, min). */
export function zonedUtc(y: number, mo: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, min);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass settles the hour around a clock change
  return t;
}

/** IST calendar date of an instant: { y, m (1-12), d, wd (0 Sun) }. */
export function istDate(ms: number) {
  const x = new Date(ms + IST_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), wd: x.getUTCDay() };
}
export const istKey = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10);
/** Midnight IST of the IST date of `ms`. */
export const istMidnight = (ms: number) => Date.parse(`${istKey(ms)}T00:00:00Z`) - IST_MS;
export const istAt = (dayMs: number, hh: number, mm: number) => istMidnight(dayMs) + (hh * 60 + mm) * 60_000;
export function fmtIst(ms: number): string {
  const x = new Date(ms + IST_MS);
  return `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`;
}

/** The nth weekday (0 Sun) of a month, or the last one with n = -1. Returns the day of month. */
export function nthWeekday(y: number, mo: number, wd: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lastWd = new Date(Date.UTC(y, mo - 1, lastDay)).getUTCDay();
  return lastDay - ((lastWd - wd + 7) % 7);
}

/** Western Easter Sunday (Anonymous Gregorian algorithm): { m, d }. */
export function easter(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

/** Chinese New Year (first day). Extend as years pass. */
export const CHINESE_NEW_YEAR: Record<number, string> = { 2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26', 2029: '2029-02-13' };

const key = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addDays = (y: number, m: number, d: number, n: number) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };

/** Market holidays that thin liquidity: US, UK and Chinese New Year. Date keys (local date) → name. */
export function holidays(y: number): Map<string, string> {
  const h = new Map<string, string>();
  const e = easter(y);
  h.set(key(y, 1, 1), 'New Year');
  h.set(key(y, 1, nthWeekday(y, 1, 1, 3)), 'MLK Day (US)');
  h.set(key(y, 2, nthWeekday(y, 2, 1, 3)), 'Presidents Day (US)');
  h.set(addDays(y, e.m, e.d, -2), 'Good Friday');
  h.set(addDays(y, e.m, e.d, 1), 'Easter Monday (UK)');
  h.set(key(y, 5, nthWeekday(y, 5, 1, 1)), 'Early May bank holiday (UK)');
  h.set(key(y, 5, nthWeekday(y, 5, 1, -1)), 'Memorial Day (US) / Spring bank holiday (UK)');
  h.set(key(y, 6, 19), 'Juneteenth (US)');
  h.set(key(y, 7, 4), 'Independence Day (US)');
  h.set(key(y, 8, nthWeekday(y, 8, 1, -1)), 'Summer bank holiday (UK)');
  h.set(key(y, 9, nthWeekday(y, 9, 1, 1)), 'Labor Day (US)');
  h.set(key(y, 11, nthWeekday(y, 11, 4, 4)), 'Thanksgiving (US)');
  h.set(key(y, 12, 25), 'Christmas');
  h.set(key(y, 12, 26), 'Boxing Day (UK)');
  const cny = CHINESE_NEW_YEAR[y];
  if (cny) h.set(cny, 'Chinese New Year');
  return h;
}

/** Clock changes that shift session times in IST: US 2nd Sun Mar / 1st Sun Nov, UK last Sun Mar / last Sun Oct. */
export function clockChanges(y: number): { key: string; name: string }[] {
  return [
    { key: key(y, 3, nthWeekday(y, 3, 0, 2)), name: 'US clocks forward' },
    { key: key(y, 3, nthWeekday(y, 3, 0, -1)), name: 'UK clocks forward' },
    { key: key(y, 10, nthWeekday(y, 10, 0, -1)), name: 'UK clocks back' },
    { key: key(y, 11, nthWeekday(y, 11, 0, 1)), name: 'US clocks back' },
  ];
}

/** Deribit monthly expiry: last Friday, 08:00 UTC. Quarter-end in Mar/Jun/Sep/Dec. */
export function deribitMonthly(y: number, m: number): { ms: number; quarter: boolean } {
  return { ms: Date.UTC(y, m - 1, nthWeekday(y, m, 5, -1), 8, 0), quarter: m % 3 === 0 };
}

/**
 * FOMC decision days (second day of each meeting), from the Federal Reserve's published calendar.
 * Add the next year's dates when the Fed publishes them; unknown years simply have no FOMC marks.
 */
export const FOMC_DECISIONS: string[] = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
];
