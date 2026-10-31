import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bar1h } from '../../lib/pulse/regime/indicators.js';
import { HourlyBars, mergeBars, parseKlines } from './hourly-bars.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

const bar = (i: number, c = 100 + i): Bar1h => ({ t: T0 + i * H, o: c - 1, h: c + 2, l: c - 2, c });

/** Fake Binance: serves bars with index <= lastIdx, newest page first like the real endpoint. */
function fakeFetch(lastIdx: number, firstIdx = 0) {
  const calls: Array<{ endTimeMs: number | null; limit: number }> = [];
  const fn = async (endTimeMs: number | null, limit: number): Promise<Bar1h[]> => {
    calls.push({ endTimeMs, limit });
    const hi = endTimeMs === null ? lastIdx : Math.min(lastIdx, Math.floor((endTimeMs - T0) / H));
    const out: Bar1h[] = [];
    for (let i = Math.max(firstIdx, hi - limit + 1); i <= hi; i++) out.push(bar(i));
    return out;
  };
  return { fn, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('parseKlines', () => {
  it('converts strings and drops rows with a NaN or missing field, sorted ascending', () => {
    const raw = [
      [T0 + H, '101', '105', '99', '103', '12', T0 + 2 * H - 1],
      [T0, '100', '104', '98', '102', '10', T0 + H - 1],
      [T0 + 2 * H, '100', 'abc', '98', '102', '10'],
      [T0 + 3 * H, '100', '104', '98'],
      'junk',
    ];
    expect(parseKlines(raw)).toEqual([
      { t: T0, o: 100, h: 104, l: 98, c: 102 },
      { t: T0 + H, o: 101, h: 105, l: 99, c: 103 },
    ]);
    expect(parseKlines({ not: 'an array' })).toEqual([]);
  });

  it('drops null, empty, boolean, zero, negative prices and high below low', () => {
    const raw = [
      [T0 + H, null, '104', '98', '102'],
      [T0 + 2 * H, '100', '', '98', '102'],
      [T0 + 3 * H, '100', true, '98', '102'],
      [T0 + 4 * H, '0', '104', '98', '102'],
      [T0 + 5 * H, '100', '104', '-98', '102'],
      [T0 + 6 * H, '100', '90', '98', '95'],
      [0, '100', '104', '98', '102'],
      [T0, '100', '104', '98', '102'],
    ];
    expect(parseKlines(raw)).toEqual([{ t: T0, o: 100, h: 104, l: 98, c: 102 }]);
  });
});

describe('mergeBars', () => {
  it('replaces a forming bar with its final version for the same open time', () => {
    const store = new Map<number, Bar1h>();
    mergeBars(store, [{ t: T0, h: 10, l: 5, c: 7 }]);
    mergeBars(store, [{ t: T0, h: 12, l: 4, c: 9 }, bar(1)]);
    expect(store.size).toBe(2);
    expect(store.get(T0)).toEqual({ t: T0, h: 12, l: 4, c: 9 });
  });
});

describe('HourlyBars.completed', () => {
  it('excludes the bar whose hour has not ended and honours barsKept', async () => {
    const f = fakeFetch(9);
    const hb = new HourlyBars({ fetchKlines: f.fn, now: () => T0 + 10 * H + 1000 }, { backfillBars: 10, barsKept: 4 });
    await hb.backfill();
    const now = T0 + 9 * H + 30 * 60_000; // bar 9 is forming
    const done = hb.completed(now);
    expect(done.map((b) => b.t)).toEqual([5, 6, 7, 8].map((i) => T0 + i * H));
    expect(hb.completed(T0 + 10 * H).at(-1)!.t).toBe(T0 + 9 * H);
    expect(hb.completed(T0 + 10 * H)).toHaveLength(4);
  });
});

describe('HourlyBars.backfill', () => {
  it('pages backwards over three pages and stops at the target count', async () => {
    const f = fakeFetch(2999);
    const hb = new HourlyBars({ fetchKlines: f.fn, now: () => T0 + 3000 * H + 5 }, { backfillBars: 2500, barsKept: 5000 });
    await hb.backfill();
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]).toEqual({ endTimeMs: null, limit: 1000 });
    expect(f.calls[1]).toEqual({ endTimeMs: T0 + 2000 * H - 1, limit: 1000 });
    expect(f.calls[2]!.endTimeMs).toBe(T0 + 1000 * H - 1);
    expect(hb.status().count).toBe(3000);
    expect(hb.status().newestOpenMs).toBe(T0 + 2999 * H);
  });

  it('stops early on an empty page', async () => {
    const f = fakeFetch(1499, 500); // only 1000 bars exist: indices 500..1499
    const hb = new HourlyBars({ fetchKlines: f.fn, now: () => T0 + 1500 * H }, { backfillBars: 9500, barsKept: 9300 });
    await hb.backfill();
    expect(f.calls).toHaveLength(2);
    expect(hb.status().count).toBe(1000);
  });
});

describe('HourlyBars.refresh', () => {
  it('on fetch failure leaves bars untouched, sets lastError, keeps lastOkAt', async () => {
    const f = fakeFetch(99);
    let now = T0 + 100 * H + 20_000;
    let fail = false;
    const fetchKlines = async (e: number | null, l: number) => {
      if (fail) throw new Error('boom 503');
      return f.fn(e, l);
    };
    const hb = new HourlyBars({ fetchKlines, now: () => now }, { backfillBars: 100, barsKept: 9300 });
    await hb.backfill();
    const before = hb.status();
    expect(before.lastOkAt).toBe(now);
    expect(before.lastError).toBeNull();
    fail = true;
    now += 60_000;
    await expect(hb.refresh()).resolves.toBeUndefined();
    const after = hb.status();
    expect(after.count).toBe(before.count);
    expect(after.newestOpenMs).toBe(before.newestOpenMs);
    expect(after.lastOkAt).toBe(before.lastOkAt);
    expect(after.lastError).toContain('boom 503');
  });

  it('runs a backfill when the newest bar is 30 hours old', async () => {
    const old = fakeFetch(99);
    const fresh = fakeFetch(129);
    let phase = 0;
    const calls: number[] = [];
    const hb = new HourlyBars(
      {
        fetchKlines: async (e, l) => { calls.push(l); return (phase === 0 ? old : fresh).fn(e, l); },
        now: () => T0 + (phase === 0 ? 100 : 130) * H + 20_000,
      },
      { backfillBars: 100, barsKept: 9300 },
    );
    await hb.backfill();
    expect(hb.status().newestOpenMs).toBe(T0 + 99 * H);
    calls.length = 0;
    phase = 1;
    await hb.refresh();
    expect(calls).toContain(1000); // paged like a backfill, not just the last 24
    expect(hb.status().newestOpenMs).toBe(T0 + 129 * H);
  });

  it('a healthy refresh fetches only the last 24 bars', async () => {
    const f = fakeFetch(99);
    const hb = new HourlyBars({ fetchKlines: f.fn, now: () => T0 + 100 * H + 20_000 }, { backfillBars: 100, barsKept: 9300 });
    await hb.backfill();
    f.calls.length = 0;
    await hb.refresh();
    expect(f.calls).toEqual([{ endTimeMs: null, limit: 24 }]);
  });
});

describe('HourlyBars.start', () => {
  it('with the fetch failing: completed() is empty and lastError is set; stop clears timers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 100 * H + 5_000);
    const fetchKlines = vi.fn(async () => { throw new Error('network down'); });
    const hb = new HourlyBars({ fetchKlines, now: () => Date.now() });
    hb.start();
    hb.start(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchKlines).toHaveBeenCalledTimes(1);
    expect(hb.completed(Date.now())).toEqual([]);
    expect(hb.status().lastError).toContain('network down');
    expect(hb.status().lastOkAt).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchKlines.mock.calls.length).toBeGreaterThan(1); // retries without throwing
    hb.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes at 20 s past the hour and retries each minute until the previous hour bar is in', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 100 * H + 30 * 60_000);
    let last = 99; // bars 0..99 exist; bar 100 is forming
    const calls: Array<number | null> = [];
    const fetchKlines = async (e: number | null, l: number) => {
      calls.push(l);
      const f = fakeFetch(last);
      return f.fn(e, l);
    };
    const hb = new HourlyBars({ fetchKlines, now: () => Date.now() }, { backfillBars: 100, barsKept: 9300 });
    hb.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(hb.status().newestOpenMs).toBe(T0 + 99 * H);
    calls.length = 0;
    // to 101:00:25 - exchange has not yet published bar 100's final, so we retry each minute
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 25_000);
    const firstCalls = calls.length;
    expect(firstCalls).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBeGreaterThan(firstCalls);
    last = 100;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hb.status().newestOpenMs).toBe(T0 + 100 * H);
    const settled = calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.length).toBe(settled); // caught up: waits for the next hour
    hb.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('HourlyBars backfill hardening', () => {
  const opts = { backfillBars: 2500, barsKept: 5000 };

  it('completes a partial startup backfill on a later refresh and only then looks healthy', async () => {
    const f = fakeFetch(2999);
    let calls = 0;
    let failPage2 = true;
    const fetchKlines = async (e: number | null, l: number) => {
      calls++;
      if (failPage2 && calls === 2) throw new Error('page 2 timeout');
      return f.fn(e, l);
    };
    const hb = new HourlyBars({ fetchKlines, now: () => T0 + 3000 * H + 20_000 }, opts);
    await hb.backfill();
    expect(hb.status().count).toBe(1000);
    expect(hb.status().lastError).toContain('page 2 timeout');
    expect(hb.status().lastOkAt).toBeNull();
    failPage2 = false;
    await hb.refresh();
    expect(hb.status().count).toBe(3000);
    expect(hb.status().lastError).toBeNull();
    expect(hb.status().lastOkAt).not.toBeNull();
  });

  it('terminates on a non-advancing page and reports incomplete', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => bar(i));
    const fetchKlines = vi.fn(async () => page);
    const hb = new HourlyBars({ fetchKlines, now: () => T0 + 1000 * H }, { backfillBars: 9500, barsKept: 9300 });
    await hb.backfill();
    expect(fetchKlines.mock.calls.length).toBeLessThanOrEqual(2);
    expect(hb.status().lastError).toContain('incomplete backfill: 1000 of 9500');
    expect(hb.status().lastOkAt).toBeNull();
  });

  it('rebuilds a 50-day-old store contiguously', async () => {
    const old = fakeFetch(99);
    const fresh = fakeFetch(1500);
    let phase = 0;
    const hb = new HourlyBars(
      { fetchKlines: (e, l) => (phase === 0 ? old : fresh).fn(e, l), now: () => T0 + (phase === 0 ? 100 : 1501) * H },
      { backfillBars: 600, barsKept: 9300 },
    );
    await hb.backfill();
    phase = 1;
    await hb.refresh();
    const ts = hb.completed(T0 + 2000 * H).map((b) => b.t);
    expect(ts.length).toBeGreaterThan(0);
    expect(ts.every((t, i) => i === 0 || t - ts[i - 1]! === H)).toBe(true);
    expect(ts[0]).toBeGreaterThan(T0 + 99 * H);
  });

  it('treats an empty first page, or one with every row dropped, as an error', async () => {
    const empty = new HourlyBars({ fetchKlines: async () => [], now: () => T0 }, opts);
    await empty.backfill();
    expect(empty.status().lastError).toContain('empty');
    expect(empty.status().lastOkAt).toBeNull();
    const dropped = new HourlyBars({ fetchKlines: async () => parseKlines([[T0, '0', '0', '0', '0']]), now: () => T0 }, opts);
    await dropped.backfill();
    expect(dropped.status().lastError).not.toBeNull();
    expect(dropped.status().lastOkAt).toBeNull();
  });

  it('treats an empty 24-bar refresh response as an error', async () => {
    const f = fakeFetch(99);
    let empty = false;
    const hb = new HourlyBars(
      { fetchKlines: async (e, l) => (empty ? [] : f.fn(e, l)), now: () => T0 + 100 * H + 20_000 },
      { backfillBars: 100, barsKept: 9300 },
    );
    await hb.backfill();
    const ok = hb.status().lastOkAt;
    empty = true;
    await hb.refresh();
    expect(hb.status().lastError).toContain('empty');
    expect(hb.status().lastOkAt).toBe(ok);
  });
});

describe('HourlyBars forming bar', () => {
  it('never stores the still-forming bar; its final version arrives on the next refresh', async () => {
    const HR = T0 + 100 * H;
    let nowMs = HR + 20_000; // H:00:20, bar 99 just closed, bar 100 (open time H) is forming
    let lastIdx = 100;
    const f = (e: number | null, l: number) => fakeFetch(lastIdx).fn(e, l);
    const hb = new HourlyBars({ fetchKlines: f, now: () => nowMs }, { backfillBars: 100, barsKept: 9300 });
    await hb.backfill();
    expect(hb.status().newestOpenMs).toBe(HR - H);
    await hb.refresh();
    expect(hb.status().newestOpenMs).toBe(HR - H);
    expect(hb.completed(HR + H + 5_000).map((b) => b.t)).not.toContain(HR);
    nowMs = HR + H + 20_000;
    lastIdx = 101; // bar 100 is final now, 101 forming
    await hb.refresh();
    const done = hb.completed(nowMs);
    expect(done.at(-1)!.t).toBe(HR);
    expect(done.at(-1)).toEqual(bar(100));
  });
});
