import { describe, expect, it } from 'vitest';
import { DAY, H, istDate } from '../calendar/time.js';
import { percentileOf, quantile, readVol, regimeOf, sessionRanges, silence, type Bar, type IvPoint } from './regime.js';

const NOW = Date.parse('2026-11-05T18:00:00Z'); // Thu 23:30 IST

/** Hourly bars; `amp(t)` is the hour's high-low swing in %. Deterministic. */
function bars(days: number, amp: (t: number) => number): Bar[] {
  const out: Bar[] = [];
  let p = 80_000;
  const start = Math.floor((NOW - days * DAY) / H) * H;
  for (let t = start, k = 0; t + H <= NOW; t += H, k++) {
    const a = amp(t) / 100;
    const o = p, c = p * (1 + (k % 2 ? a / 3 : -a / 3));
    out.push({ t, o, h: Math.max(o, c) * (1 + a / 2), l: Math.min(o, c) * (1 - a / 2), c });
    p = c;
  }
  return out;
}
const daily = (n: number, swing = 2): Bar[] => Array.from({ length: n }, (_, k) => {
  const c = 80_000 * (1 + Math.sin(k / 5) * 0.03);
  return { t: NOW - (n - k) * DAY, o: c, h: c * (1 + swing / 200), l: c * (1 - swing / 200), c };
});
const ivSeries = (n: number, f: (k: number) => number, step = DAY, end = NOW): IvPoint[] => Array.from({ length: n }, (_, k) => ({ t: end - (n - k) * step, v: f(k) }));
const yearIv = ivSeries(365, (k) => 35 + 20 * ((k * 37) % 100) / 100); // spread 35..55

describe('maths', () => {
  it('percentile and quantile', () => {
    expect(percentileOf(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(45);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
  it('regime bands', () => {
    expect([10, 30, 55, 80, 95].map((p) => regimeOf(p))).toEqual(['Dead', 'Low', 'Core', 'Rich', 'Crisis']);
  });
});

describe('silence counter', () => {
  it('counts consecutive quiet weekday London sessions; weekends neither count nor break the run', () => {
    // London quiet on the last 3 weekdays (Mon 2, Tue 3, Wed 4 Nov 2026 → Thu 5 still running at 23:30 IST? London ends 22:30 → counted)
    const quietFrom = Date.parse('2026-10-31T00:00:00Z');
    const b = bars(100, (t) => {
      const londonHour = ((new Date(t).getUTCHours() + 24) % 24) >= 8 && new Date(t).getUTCHours() < 17;
      return londonHour && t >= quietFrom ? 0.05 : 0.6 + 0.4 * ((t / H) % 7) / 7;
    });
    const s = silence(sessionRanges(b, NOW), 'London');
    expect(s.quietRun).toBe(4); // Mon, Tue, Wed, Thu (Sat 31 Oct and Sun 1 Nov are skipped)
    expect(s.dots.slice(-4)).toEqual([true, true, true, true]);
  });
});

describe('readVol', () => {
  const base = { nowMs: NOW, bars1h: bars(100, (t) => 0.6 + 0.4 * ((t / H) % 7) / 7), closes1d: daily(400) };

  it('IV in the core band, healthy IV/RV: no block, full size', () => {
    const r = readVol({ ...base, dvolDaily: yearIv, dvolHourly: ivSeries(96, () => 46, H), ivNow: 46 });
    expect(r.iv.regime).toBe('Core');
    expect(r.deadIv.dead).toBe(false);
    expect(r.gate.reasons.filter((x) => /IV regime|Dead IV/.test(x))).toEqual([]);
  });

  it('IV at the bottom of its year is Dead: blocked', () => {
    const r = readVol({ ...base, dvolDaily: yearIv, dvolHourly: ivSeries(96, () => 35.5, H), ivNow: 35.5 });
    expect(r.iv.regime).toBe('Dead');
    expect(r.deadIv.dead).toBe(true);
    expect(r.gate.block).toBe(true);
  });

  it('IV above the 90th percentile is Crisis: blocked', () => {
    const r = readVol({ ...base, dvolDaily: yearIv, dvolHourly: ivSeries(96, () => 56, H), ivNow: 56 });
    expect(r.iv.regime).toBe('Crisis');
    expect(r.gate.reasons.join(' ')).toContain('Crisis');
  });

  it('Rich regime halves the size', () => {
    const r = readVol({ ...base, dvolDaily: yearIv, dvolHourly: ivSeries(96, () => 51, H), ivNow: 51 });
    expect(r.iv.regime).toBe('Rich');
    expect(r.gate.sizeMult).toBe(0.5);
  });

  it('five quiet weekdays in a row is a Squeeze: no new strangles', () => {
    const quietFrom = Date.parse('2026-10-28T00:00:00Z');
    const b = bars(100, (t) => (t >= quietFrom ? 0.04 : 0.6 + 0.4 * ((t / H) % 7) / 7));
    const r = readVol({ ...base, bars1h: b, dvolDaily: yearIv, dvolHourly: ivSeries(96, () => 46, H), ivNow: 46 });
    expect(r.compression.level).toBe('Squeeze');
    expect(r.gate.reasons.join(' ')).toContain('Squeeze');
    expect(istDate(NOW).wd).toBe(4);
  });

  it('no IV history means no regime and no dead-IV verdict, never a green guess', () => {
    const r = readVol({ ...base, dvolDaily: [], dvolHourly: [], ivNow: null });
    expect(r.iv.regime).toBeNull();
    expect(r.deadIv.dead).toBeNull();
  });
});

describe('session ranges reach today', () => {
  it('whatever hour the history starts at, the latest finished session is included', () => {
    for (const startHour of [0, 7, 16, 23]) {
      const start = Date.parse('2026-10-20T00:00:00Z') + startHour * H;
      const b: Bar[] = [];
      for (let t = start; t + H <= NOW; t += H) b.push({ t, o: 1, h: 1.01, l: 0.99, c: 1 });
      const last = sessionRanges(b, NOW).at(-1)!;
      expect(last.dateKey).toBe('2026-11-05'); // Thu: Asia and London finished by 23:30 IST
      expect(last.session).toBe('London');
    }
  });
});
