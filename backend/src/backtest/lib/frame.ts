/**
 * Session framing + time helpers — VERBATIM from stage1_backtest.ts (lines 53-99).
 * Defines the overnight trade session: NY open (19:00 IST, EDT/EST aware), 07:00 IST
 * exit, the N2N (3rd) expiry key and its 17:30 IST settlement. Do not alter.
 */
export const MIN = 60_000;
export const HR = 3_600_000;
export const DAY = 86_400_000;
export const IST = 19_800_000;

export const yrs = (ms: number) => ms / (365 * DAY);
export const d0 = (d: string) => Date.parse(d + 'T00:00:00Z') - IST;
export const keyOf = (idx: number) => new Date(idx * DAY).toISOString().slice(0, 10);
export const dk = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

function nthSun(y: number, m: number, n: number): number {
  const d = new Date(Date.UTC(y, m, 1));
  const first = (7 - d.getUTCDay()) % 7;
  return Date.UTC(y, m, 1 + first + 7 * (n - 1));
}

export function isEDT(ms: number): boolean {
  const y = new Date(ms).getUTCFullYear();
  return ms >= nthSun(y, 2, 2) + 7 * HR && ms < nthSun(y, 10, 1) + 6 * HR;
}

export interface Frame {
  base: number;
  D0: number;
  edt: boolean;
  open: number;
  end: number;
  exit: number;
  cur: string;
  nxt: string;
  n2n: string;
  settle: number;
  listing: number;
  dow: number;
}

export function frame(now: number): Frame {
  const base = Math.floor((now + IST - 17.5 * HR) / DAY);
  const D0 = base * DAY - IST;
  const edt = isEDT(D0 + 14 * HR);
  const open = D0 + (edt ? 19 : 20) * HR;
  return {
    base,
    D0,
    edt,
    open,
    end: open + 7.5 * HR,
    exit: D0 + 31 * HR, // 07:00 IST next morning
    cur: keyOf(base + 1),
    nxt: keyOf(base + 2),
    n2n: keyOf(base + 3),
    settle: (base + 3) * DAY - IST + 17.5 * HR,
    listing: D0 + 17.5 * HR,
    dow: new Date(base * DAY).getUTCDay(),
  };
}

/** Forward-fill step lookup over a sorted [t, value][] series — VERBATIM from stage1. */
export function at(s: [number, number][], t: number): number | null {
  if (!s || !s.length || t < s[0][0]) return null;
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (s[m][0] <= t) lo = m;
    else hi = m - 1;
  }
  return s[lo][1];
}
