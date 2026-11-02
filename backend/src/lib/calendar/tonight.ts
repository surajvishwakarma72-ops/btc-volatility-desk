/**
 * Market psychology, part C of the build prompt: sessions in IST (daylight saving followed automatically), the
 * month × week × day size multipliers, Green/Amber/Red week ratings, and the "Tonight" verdict for the 23:00 entry.
 * Multipliers are starting values from published BTC volatility studies and the event calendar, not a strangle backtest.
 */
import {
  clockChanges, DAY, deribitMonthly, FOMC_DECISIONS, H, holidays, istDate, istKey, istMidnight, nthWeekday, zonedUtc,
} from './time.js';

const LDN = 'Europe/London', NY = 'America/New_York';

export interface Release { title: string; atMs: number; kind: 'CPI' | 'NFP' | 'FOMC' | 'PCE' | 'OTHER'; estimated?: boolean }

export function releaseKind(title: string): Release['kind'] {
  if (/\bcpi\b|consumer price/i.test(title)) return 'CPI';
  if (/non-?farm|payrolls/i.test(title)) return 'NFP';
  if (/fomc|federal funds|rate decision|fed chair|powell/i.test(title)) return 'FOMC';
  if (/\bpce\b/i.test(title)) return 'PCE';
  return 'OTHER';
}

// ---------------- sessions ----------------

export interface Sessions {
  dateKey: string;
  asia: [number, number];
  london: [number, number];
  ny: [number, number];
  overlap: [number, number];
  /** NY cash open 09:30 ET. */
  nyOpen: number;
  /** US data 08:30 ET. */
  usData: number;
  /** FOMC statement 14:00 ET (that evening in IST = after midnight). */
  fomc: number;
  deltaSettle: number;
  deribitSettle: number | null;
  /** Your entry window: NY open + `entryAfterNyOpenMin` ± 30 min. */
  entry: [number, number];
  usSummer: boolean;
  ukSummer: boolean;
}

/** Sessions for the IST date that contains `dayMs`. London 08:00–17:00 local, New York 09:00–18:00 local (as in the prompt's table). */
export function sessionsFor(dayMs: number, entryAfterNyOpenMin = 180): Sessions {
  const { y, m, d, wd } = istDate(dayMs);
  const mid = istMidnight(dayMs);
  const london: [number, number] = [zonedUtc(y, m, d, 8, 0, LDN), zonedUtc(y, m, d, 17, 0, LDN)];
  const ny: [number, number] = [zonedUtc(y, m, d, 9, 0, NY), zonedUtc(y, m, d, 18, 0, NY)];
  const nyOpen = zonedUtc(y, m, d, 9, 30, NY);
  const entryMid = nyOpen + entryAfterNyOpenMin * 60_000;
  const usSummer = (ny[0] - Date.UTC(y, m - 1, d, 9, 0)) === 4 * H;
  const ukSummer = (london[0] - Date.UTC(y, m - 1, d, 8, 0)) === -1 * H;
  return {
    dateKey: istKey(dayMs),
    asia: [mid + 5.5 * H, london[0]],
    london, ny,
    overlap: [Math.max(london[0], ny[0]), Math.min(london[1], ny[1])],
    nyOpen,
    usData: zonedUtc(y, m, d, 8, 30, NY),
    fomc: zonedUtc(y, m, d, 14, 0, NY),
    deltaSettle: mid + 17.5 * H,
    deribitSettle: wd === 5 ? Date.UTC(y, m - 1, d, 8, 0) : null,
    entry: [entryMid - 30 * 60_000, entryMid + 30 * 60_000],
    usSummer, ukSummer,
  };
}

// ---------------- week of month and ratings ----------------

/** W1..W4 by day of month (days 29-31 count as W4). */
export const weekOfMonth = (d: number) => Math.min(4, Math.ceil(d / 7));

/** Monday 00:00 IST of the IST week containing `ms`. */
export function weekStart(ms: number): number {
  const wd = istDate(ms).wd;
  return istMidnight(ms) - ((wd + 6) % 7) * DAY;
}

export type Rating = 'Green' | 'Amber' | 'Red';
export interface WeekRating { start: number; rating: Rating; reasons: string[]; events: { dateKey: string; label: string }[] }

/** Known scheduled events of a week: releases (live calendar, else estimated NFP), FOMC, holidays, clock changes, Deribit monthly. */
export function weekEvents(start: number, releases: Release[]): { dateKey: string; label: string; kind: string; ms?: number }[] {
  const end = start + 7 * DAY;
  const out: { dateKey: string; label: string; kind: string; ms?: number }[] = [];
  const years = new Set([istDate(start).y, istDate(end - 1).y]);
  for (const r of releases) if (r.atMs >= start && r.atMs < end && r.kind !== 'OTHER') out.push({ dateKey: istKey(r.atMs), label: r.kind + (r.estimated ? ' (expected)' : ''), kind: r.kind, ms: r.atMs });
  for (const f of FOMC_DECISIONS) {
    const [fy, fm, fd] = f.split('-').map(Number) as [number, number, number];
    const ms = zonedUtc(fy, fm, fd, 14, 0, NY);
    if (ms >= start && ms < end && !out.some((x) => x.kind === 'FOMC')) out.push({ dateKey: istKey(ms), label: 'FOMC', kind: 'FOMC', ms });
  }
  for (const y of years) {
    for (const [k, name] of holidays(y)) { const ms = Date.parse(`${k}T12:00:00Z`); if (ms >= start && ms < end) out.push({ dateKey: k, label: name, kind: 'HOLIDAY' }); }
    for (const c of clockChanges(y)) { const ms = Date.parse(`${c.key}T12:00:00Z`); if (ms >= start - DAY && ms < end) out.push({ dateKey: c.key, label: c.name, kind: 'CLOCK' }); }
  }
  for (let t = start; t < end; t += DAY) {
    const { y, m, d } = istDate(t);
    const dm = deribitMonthly(y, m);
    if (istKey(dm.ms) === istKey(t)) out.push({ dateKey: istKey(t), label: dm.quarter ? 'Deribit quarterly expiry' : 'Deribit monthly expiry', kind: dm.quarter ? 'QEXP' : 'MEXP', ms: dm.ms });
    void d;
  }
  return out.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

const THIN = /Christmas|Boxing|New Year|Thanksgiving|Independence|Chinese New Year/;

export function rateWeek(start: number, releases: Release[]): WeekRating {
  const ev = weekEvents(start, releases);
  const top = ev.filter((e) => ['CPI', 'NFP', 'FOMC'].includes(e.kind));
  const reasons: string[] = [];
  let rating: Rating = 'Green';
  const red = (r: string) => { rating = 'Red'; reasons.push(r); };
  const amber = (r: string) => { if (rating === 'Green') rating = 'Amber'; reasons.push(r); };
  // CPI usually prints on the 10th-14th; until its date is published the week must not look clear
  const cpiLikely = !top.some((e) => e.kind === 'CPI') && Array.from({ length: 7 }, (_, k) => istDate(start + k * DAY)).some((x) => x.d >= 10 && x.d <= 14 && x.wd >= 2 && x.wd <= 4);
  if (cpiLikely) top.push({ dateKey: '', label: 'CPI (date not published yet)', kind: 'CPI' });
  if (top.length >= 2) red(`${top.length} top-tier events (${top.map((e) => e.label).join(', ')})`);
  else if (top.length === 1) amber(`${top[0]!.label} this week`);
  if (ev.some((e) => e.kind === 'QEXP')) red('quarter-end Deribit expiry');
  if (ev.some((e) => e.kind === 'CLOCK')) red('clock-change week: session times shift');
  const thin = ev.filter((e) => e.kind === 'HOLIDAY' && THIN.test(e.label));
  if (thin.length) red(`holiday-thin (${thin.map((e) => e.label).join(', ')})`);
  else if (ev.some((e) => e.kind === 'HOLIDAY')) amber(`holiday: ${ev.filter((e) => e.kind === 'HOLIDAY').map((e) => e.label).join(', ')}`);
  const sm = istDate(start + 3 * DAY).m;
  if (sm >= 6 && sm <= 8 && rating === 'Green') amber('summer-thin markets');
  if (!reasons.length) reasons.push('no top-tier release, normal liquidity');
  return { start, rating, reasons, events: ev.map(({ dateKey, label }) => ({ dateKey, label })) };
}

/** First Friday of the month at 08:30 ET: the usual NFP slot, used when the live calendar does not reach that far. */
export function expectedNfp(y: number, m: number): Release {
  return { title: 'Non-Farm Payrolls', atMs: zonedUtc(y, m, nthWeekday(y, m, 5, 1), 8, 30, NY), kind: 'NFP', estimated: true };
}

// ---------------- calendar sizing ----------------

export const MONTH_MULT = [1.0, 0.5, 0.75, 0.5, 0.5, 0.75, 1.0, 0.75, 1.0, 0.5, 0.5, 0.75];

export interface CalendarSize { month: number; week: number; day: number; product: number; skip: boolean; notes: string[] }

/** Size multipliers for an entry at `entryMs` (section 9.11b). Max 1.0 × base; under 0.25 the calendar says skip. */
export function calendarSize(entryMs: number, releases: Release[]): CalendarSize {
  const { y, m, d, wd } = istDate(entryMs);
  const notes: string[] = [];
  let month = MONTH_MULT[m - 1]!;
  if (m === 12 && d < 20) month = 1.0;
  notes.push(`${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ×${month}`);

  const w = weekOfMonth(d);
  const ws = weekStart(entryMs), we = ws + 7 * DAY;
  const inWeek = (k: Release['kind']) => releases.filter((r) => r.kind === k && r.atMs >= ws && r.atMs < we);
  const fomcWeek = FOMC_DECISIONS.some((f) => { const [a, b, c] = f.split('-').map(Number) as [number, number, number]; const t = zonedUtc(a, b, c, 14, 0, NY); return t >= ws && t < we; });
  let week: number;
  if (w === 1) week = 0.75;
  else if (w === 2) { const cpi = inWeek('CPI'); week = cpi.length && cpi.every((r) => r.atMs + 2 * H <= entryMs) ? 1.0 : cpi.length ? 0.5 : 1.0; }
  else if (w === 3) { week = fomcWeek ? (FOMC_DECISIONS.some((f) => { const [a, b, c] = f.split('-').map(Number) as [number, number, number]; return zonedUtc(a, b, c, 14, 0, NY) + 2 * H <= entryMs && zonedUtc(a, b, c, 14, 0, NY) >= ws; }) ? 1.0 : 0.5) : 1.0; }
  else { const dm = deribitMonthly(y, m); const thin = [...holidays(y)].some(([k, n]) => THIN.test(n) && Date.parse(`${k}T12:00:00Z`) >= ws && Date.parse(`${k}T12:00:00Z`) < we); week = dm.quarter || thin ? 0.5 : 0.75; }
  notes.push(`W${w} ×${week}`);

  const s = sessionsFor(entryMs);
  const nyDone = entryMs >= s.nyOpen + 60 * 60_000;
  const fomcToday = FOMC_DECISIONS.some((f) => { const [a, b, c] = f.split('-').map(Number) as [number, number, number]; return istKey(zonedUtc(a, b, c, 14, 0, NY)) === istKey(entryMs) || istKey(zonedUtc(a, b, c, 14, 0, NY) - DAY) === istKey(entryMs); });
  const nfpToday = releases.some((r) => r.kind === 'NFP' && istKey(r.atMs) === istKey(entryMs));
  let day: number;
  switch (wd) {
    case 1: day = nyDone ? 0.75 : 0.5; break;
    case 2: day = 1.0; break;
    case 3: day = fomcToday ? 0.5 : 1.0; break;
    case 4: day = 0.75; break;
    case 5: { const after = entryMs >= (s.deribitSettle ?? 0) && (!nfpToday || releases.some((r) => r.kind === 'NFP' && istKey(r.atMs) === istKey(entryMs) && r.atMs + 2 * H <= entryMs)); day = after ? 0.75 : 0.5; break; }
    default: day = 0.5;
  }
  notes.push(`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]} ×${day}`);
  const product = Math.round(month * week * day * 1000) / 1000;
  return { month, week, day, product, skip: product < 0.25, notes };
}

// ---------------- day-of-week rule ----------------

export const DAY_RULES: Record<number, { tends: string; rule: string; sell: string }> = {
  1: { tends: 'Weekend price tested; sharp moves on returning liquidity', rule: 'If Asia already moved and settled, normal gates from London on; if Asia was quiet too, wait for the NY open to settle.', sell: 'Wednesday expiry' },
  2: { tends: 'Often calmer after Monday’s repricing', rule: 'Good entry if the calendar is clear; check CPI.', sell: 'N2N expiry' },
  3: { tends: 'Mid-week; FOMC lands ~00:30 IST Thursday', rule: 'No fresh strangle into FOMC unless IV prices it.', sell: 'N2N expiry' },
  4: { tends: 'Positioning and rolls before Friday’s Deribit expiry', rule: 'Must survive Friday settlement, Friday data and the thin Saturday.', sell: 'Saturday expiry' },
  5: { tends: 'Deribit settles 13:30 IST; NFP on the first Friday', rule: 'No entry just before 13:30 or the 19:00 data; check IV crush vs expansion after settlement.', sell: 'N2N expiry' },
  6: { tends: 'Thin books; institutions away', rule: 'Half risk.', sell: 'Monday expiry (weekend strangle)' },
  0: { tends: 'Thin until Monday Asia; evening re-hedging', rule: 'Exit weekend trades on plan; don’t carry into the Monday open.', sell: 'N2N expiry' },
};

// ---------------- tonight ----------------

export type TonightVerdict = 'CLEAN' | 'CAUTION' | 'SKIP';
export interface Tonight {
  sessions: Sessions;
  entryMs: number;
  weekday: string;
  dayRule: (typeof DAY_RULES)[number];
  thisWeek: WeekRating;
  nextWeek: WeekRating;
  size: CalendarSize;
  /** Top-tier releases between entry and the end of the hold. */
  inPath: { label: string; atMs: number }[];
  holdEndMs: number;
  verdict: TonightVerdict;
  reasons: string[];
  shiftedThisWeek: boolean;
}

/**
 * "Is tonight's entry window clean?" Entry at the middle of the entry window; the hold runs to `holdEndMs`
 * (the expiry to be sold, else 24 h). Red: an event in the path, or the calendar product under 0.25.
 */
export function tonight(nowMs: number, releases: Release[], holdEndMs?: number, entryAfterNyOpenMin = 180): Tonight {
  const s = sessionsFor(nowMs, entryAfterNyOpenMin);
  const entryMs = (s.entry[0] + s.entry[1]) / 2;
  const hold = holdEndMs ?? entryMs + 24 * H;
  const wd = istDate(nowMs).wd;
  const ws = weekStart(nowMs);
  const thisWeek = rateWeek(ws, releases), nextWeek = rateWeek(ws + 7 * DAY, releases);
  const size = calendarSize(entryMs, releases);
  const fomcMs = FOMC_DECISIONS.map((f) => { const [a, b, c] = f.split('-').map(Number) as [number, number, number]; return zonedUtc(a, b, c, 14, 0, NY); });
  const inPath = [
    ...releases.filter((r) => r.kind !== 'OTHER' && r.atMs > entryMs - H && r.atMs < hold).map((r) => ({ label: r.kind + (r.estimated ? ' (expected)' : ''), atMs: r.atMs })),
    ...fomcMs.filter((t) => t > entryMs - H && t < hold && !releases.some((r) => r.kind === 'FOMC' && Math.abs(r.atMs - t) < 3 * H)).map((t) => ({ label: 'FOMC', atMs: t })),
  ].sort((a, b) => a.atMs - b.atMs);
  const reasons: string[] = [];
  let verdict: TonightVerdict = 'CLEAN';
  if (inPath.length) { verdict = 'SKIP'; reasons.push(`${inPath.map((e) => e.label).join(', ')} inside the hold: sell after it, not before`); }
  if (size.skip) { verdict = 'SKIP'; reasons.push(`calendar stacks too many risks (size ×${size.product})`); }
  if (verdict === 'CLEAN') {
    if (thisWeek.rating === 'Red') { verdict = 'CAUTION'; reasons.push(`Red week: ${thisWeek.reasons.join('; ')}`); }
    else if (size.product < 0.5) { verdict = 'CAUTION'; reasons.push(`small size today (×${size.product})`); }
    else if (wd === 0 || wd === 6) { verdict = 'CAUTION'; reasons.push('weekend: half risk'); }
  }
  if (!reasons.length) reasons.push('no top-tier event in the hold, calendar size normal');
  const shiftedThisWeek = thisWeek.events.some((e) => /clocks/.test(e.label));
  return {
    sessions: s, entryMs, weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd]!,
    dayRule: DAY_RULES[wd]!, thisWeek, nextWeek, size, inPath, holdEndMs: hold, verdict, reasons, shiftedThisWeek,
  };
}
