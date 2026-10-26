import { IST_OFFSET_MS } from '../bot/schedule.js';

/** Pure helpers over the recorded ATM IV / DVOL series (the database part lives in services/algo/series.ts). */
export interface Sample { t: number; atmIv: number | null; dvol: number | null; spot: number | null }

/** The value `minutesAgo` before `nowMs`: the sample nearest that time, if it is within a third of the lookback of it. */
export function valueAgo(rows: readonly Sample[], key: 'atmIv' | 'dvol', nowMs: number, minutesAgo: number): number | null {
  const target = nowMs - minutesAgo * 60_000, tol = Math.max(2, minutesAgo / 3) * 60_000;
  let best: Sample | null = null;
  for (const r of rows) {
    if (r[key] == null) continue;
    if (!best || Math.abs(r.t - target) < Math.abs(best.t - target)) best = r;
  }
  return best && Math.abs(best.t - target) <= tol ? best[key] : null;
}

export function latest(rows: readonly Sample[], key: 'atmIv' | 'dvol'): number | null {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]![key] != null) return rows[i]![key];
  return null;
}

/** Minutes after IST midnight of an instant */
export const istMinuteOfDay = (ms: number) => Math.floor((((ms + IST_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000);

export interface ClockIv { value: number; source: 'ATM IV' | 'DVOL'; days: number }

/**
 * What the IV usually is at this clock time: the average of the samples within `halfWindowMin` of the same IST time on each earlier day.
 * ATM IV is used when at least `minDays` earlier days have it; otherwise DVOL, so the comparison works while ATM IV history is still building.
 */
export function clockIv(rows: readonly Sample[], nowMs: number, minDays = 3, halfWindowMin = 20): ClockIv | null {
  const nowMod = istMinuteOfDay(nowMs), todayStart = Math.floor((nowMs + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
  const perDay = (key: 'atmIv' | 'dvol') => {
    const days = new Map<number, number[]>();
    for (const r of rows) {
      const v = r[key]; if (v == null || r.t >= todayStart) continue;
      const m = istMinuteOfDay(r.t), d = Math.min(Math.abs(m - nowMod), 1440 - Math.abs(m - nowMod));
      if (d > halfWindowMin) continue;
      const day = Math.floor((r.t + IST_OFFSET_MS) / 86_400_000);
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(v);
    }
    const means = [...days.values()].map((a) => a.reduce((x, y) => x + y, 0) / a.length);
    return { n: means.length, mean: means.length ? means.reduce((x, y) => x + y, 0) / means.length : 0 };
  };
  const a = perDay('atmIv');
  if (a.n >= minDays) return { value: a.mean, source: 'ATM IV', days: a.n };
  const d = perDay('dvol');
  return d.n >= 2 ? { value: d.mean, source: 'DVOL', days: d.n } : null;
}
