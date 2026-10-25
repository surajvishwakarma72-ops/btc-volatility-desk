/**
 * Server-side port of the desk's session calendar (frontend/index.html, SessCal).
 *   Asia      05:30 IST all year, ends when London opens
 *   London    opens 08:00 UK time (winter 13:30 IST, BST 12:30 IST), ends when New York opens
 *   New York  09:30-16:00 New York time (EST 20:00-02:30 IST, EDT 19:00-01:30 IST)
 * A session belongs to the IST day it starts on; New York runs past midnight.
 */
const H = 3_600_000;
const D = 86_400_000;
const IST = 19_800_000;

export type SessionName = 'ASIA' | 'LONDON' | 'NEW YORK';

const nthSun = (y: number, m: number, n: number): number => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + 7 * (n - 1);
};
const lastSun = (y: number, m: number): number => {
  const last = new Date(Date.UTC(y, m + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
};

export function ukDstAt(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  return ms >= Date.UTC(y, 2, lastSun(y, 2), 1) && ms < Date.UTC(y, 9, lastSun(y, 9), 1);
}

export function usDstAt(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  return ms >= Date.UTC(y, 2, nthSun(y, 2, 2), 7) && ms < Date.UTC(y, 10, nthSun(y, 10, 1), 6);
}

/** IST day number (days since 1970-01-01 in IST). */
export const istDay = (ms: number): number => Math.floor((ms + IST) / D);

const refMs = (d: number) => d * D - IST + 18 * H; // 18:00 IST: after every clock change of that day

export function sessionHours(d: number): Record<SessionName, { start: number; end: number }> {
  const t = refMs(d);
  const londonStart = ukDstAt(t) ? 12.5 : 13.5;
  const nyStart = usDstAt(t) ? 19 : 20;
  const nyEnd = usDstAt(t) ? 25.5 : 26.5;
  return {
    ASIA: { start: 5.5, end: londonStart },
    LONDON: { start: londonStart, end: nyStart },
    'NEW YORK': { start: nyStart, end: nyEnd },
  };
}

/** Absolute [start, end) in epoch ms of a session that starts on IST day `d`. */
export function sessionBounds(name: SessionName, d: number): { start: number; end: number } {
  const r = sessionHours(d)[name];
  return { start: d * D - IST + r.start * H, end: d * D - IST + r.end * H };
}

export function sessionAt(ms: number): SessionName | 'OFF' {
  const d = istDay(ms);
  for (const day of [d, d - 1]) {
    for (const n of ['ASIA', 'LONDON', 'NEW YORK'] as SessionName[]) {
      const b = sessionBounds(n, day);
      if (ms >= b.start && ms < b.end) return n;
    }
  }
  return 'OFF';
}

export function istDateKeyOfDay(d: number): string {
  return new Date(d * D).toISOString().slice(0, 10);
}
