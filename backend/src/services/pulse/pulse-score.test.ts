import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PulseCohort } from '../../lib/pulse/snapshot.js';
import type { MinuteRow } from '../../lib/pulse/metrics/damage.js';

const h = vi.hoisted(() => ({
  cohorts: [] as unknown[],
  rows: [] as unknown[],
  minuteFails: false,
  minuteCalls: [] as number[],
  /** Set by the size test: a full 48 hours of 15-minute output, with every value present. */
  full: null as null | { readings: unknown[]; pnlRows: unknown[] },
}));

vi.mock('./pulse-store.js', () => ({
  pulseTablesExist: async () => true,
  recentCohorts: async () => h.cohorts,
  cohortRowsMany: async (ids: string[]) => new Map(ids.map((id) => [id, h.full?.pnlRows ?? []])),
  latestMarketRows: async () => [],
  minuteRows: async (_slot: string, fromMs: number) => {
    h.minuteCalls.push(fromMs);
    if (h.minuteFails) throw new Error('minute read failed');
    return h.rows;
  },
}));

vi.mock('./regime-service.js', () => ({
  regimeService: { snapshot: () => ({ pass: true, reasons: [], inputs: [] }) },
}));

vi.mock('../../lib/pulse/metrics/series.js', async (orig) => ({
  ...(await orig<typeof import('../../lib/pulse/metrics/series.js')>()),
  metricSeries: () => [],
  winnerAtAge: () => null,
}));

// The 15-minute reading is not under test: hand back one fixed reading so a card and a base point exist.
vi.mock('../../lib/pulse/score/score.js', async (orig) => {
  const actual = await orig<typeof import('../../lib/pulse/score/score.js')>();
  return {
    ...actual,
    readings: () => h.full?.readings ?? [{
      t: Date.now() - 60_000, zone: 'caution', verdict: 'WAIT', confidence: 55, rawZone: 'caution', gateBlocked: false,
      vetoes: [], why: [], flips: null, heavyLeg: null, parts: null,
    }],
    linesAt: (t: number, c: Parameters<typeof actual.linesAt>[1]) => (h.full
      ? { call: 41.23456789012345, put: 38.76543210987654, futLong: 12.34567890123456, futShort: 0 }
      : actual.linesAt(t, c)),
  };
});

const { pulseScore, pulseNow } = await import('./pulse-score.js');

const MIN = 60_000;
const HOUR = 3_600_000;
const FLAG = process.env.PULSE_MINUTE_LANE;

function cohort(slotMs: number): PulseCohort {
  return {
    id: `c${slotMs}`, slot: 'current', series_id: 's', slot_ms: slotMs, expiry_ms: slotMs + 48 * HOUR, status: 'open',
    opened_at: slotMs, closed_at: null, close_reason: null, spot_entry: 100000, fut_entry_bid: 100000, fut_entry_ask: 100000,
    call_symbol: 'C', put_symbol: 'P', call_strike: 105000, put_strike: 95000, call_bid: 100, put_bid: 100,
  } as PulseCohort;
}

function minuteRowsFor(slotMs: number, n: number, endMs: number): MinuteRow[] {
  return Array.from({ length: n }, (_, i) => ({
    t: endMs - (n - 1 - i) * MIN, cohort_id: slotMs, fut_price: 100000 + (i % 7) * 13.37, call_mid: 100 + (i % 5) * 1.234,
    put_mid: 100 + (i % 3) * 1.111, call_iv: 50, put_iv: 50, data_ok: true,
  }));
}

let slotN = 0;
const slot = 'current' as const;
beforeEach(() => {
  h.cohorts = []; h.rows = []; h.minuteFails = false; h.minuteCalls = []; h.full = null;
  // The score is cached per slot for 45 s, so each test uses its own cache key.
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-02T12:00:00Z') + slotN++ * 3 * HOUR);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (FLAG === undefined) delete process.env.PULSE_MINUTE_LANE; else process.env.PULSE_MINUTE_LANE = FLAG;
});

function seed(n = 120) {
  const slotMs = Date.now() - 3 * HOUR;
  h.cohorts = [cohort(slotMs)];
  h.rows = minuteRowsFor(slotMs, n, Date.now());
}
// Bust the 45 s cache between calls in one test.
const bust = () => vi.setSystemTime(Date.now() + 60_000);

describe('pulseScore minute block', () => {
  it('has no minute block with the flag off', async () => {
    process.env.PULSE_MINUTE_LANE = 'false';
    seed();
    const body = await pulseScore(slot);
    expect(body.minute).toBeNull();
    expect(h.minuteCalls).toEqual([]);
  });

  it('adds the minute block with the flag on', async () => {
    process.env.PULSE_MINUTE_LANE = 'true';
    seed();
    const body = await pulseScore(slot);
    expect(Array.isArray(body.minute)).toBe(true);
    expect(body.minute!.length).toBeGreaterThan(0);
    const p = body.minute![0];
    expect(Object.keys(p).sort()).toEqual(['call', 'fl', 'fs', 'hurt', 'put', 'r', 't', 'z'].sort()); // trigger is sent only when true
    for (const v of [p.r, p.call, p.put, p.fl, p.fs]) if (v !== null) expect(Math.round(v * 10) / 10).toBe(v);
    // Reads the history window plus 60 minutes for the futures window, and returns only the history window.
    const from = Date.now() - 48 * HOUR - 60 * MIN;
    expect(h.minuteCalls[0]).toBeGreaterThanOrEqual(from - 1000);
    expect(h.minuteCalls[0]).toBeLessThanOrEqual(from + 1000);
    for (const m of body.minute!) expect(m.t).toBeGreaterThanOrEqual(Date.now() - 48 * HOUR);
  });

  it('pulseNow returns the same reading with the flag on or off', async () => {
    seed();
    process.env.PULSE_MINUTE_LANE = 'false';
    const off = await pulseNow(slot);
    bust();
    process.env.PULSE_MINUTE_LANE = 'true';
    const on = await pulseNow(slot);
    expect(off).not.toBeNull();
    expect(on).toEqual({ ...off, t: on!.t });
    expect(on!.zone).toBe(off!.zone);
    expect(on!.risk).toBe(off!.risk);
  });

  it('a failed minute read leaves the rest of the score intact', async () => {
    process.env.PULSE_MINUTE_LANE = 'true';
    seed();
    h.minuteFails = true;
    const body = await pulseScore(slot);
    expect(body.minute).toBeNull();
    expect(body.card).not.toBeNull();
    expect(body.points.length).toBe(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('keeps the whole body under 400 KB at 48 hours', async () => {
    process.env.PULSE_MINUTE_LANE = 'true';
    const now = Date.now();
    const slotMs = now - 3 * HOUR;
    h.cohorts = [cohort(slotMs)];
    // A worst case: every minute has a full point, every 15-minute point changes zone, and one cohort has three days of P&L rows.
    // Lines with two digits and a decimal, the futures moving, and damage on a side in most minutes: the longest point the block makes.
    h.rows = minuteRowsFor(slotMs, 2880, now).map((r, i) => ({ ...r, fut_price: 100_000 * (1 + 0.004 * Math.sin(i / 25)), call_mid: 100 + (i % 11) * 0.3 }));
    h.full = {
      readings: Array.from({ length: 192 }, (_, i) => ({
        t: now - (191 - i) * 15 * MIN, zone: i % 2 ? 'caution' : 'avoid', verdict: 'WAIT', confidence: 55.5, rawZone: 'caution', gateBlocked: false,
        vetoes: [], why: ['Spread too wide on the put leg to sell it safely'], flips: null, heavyLeg: null, parts: null,
      })),
      pnlRows: Array.from({ length: 288 }, (_, i) => {
        const leg = { net_pnl: -123.45678901234567, delta: 0.123456789, gamma: 0.000123456, theta: -4.12345678, vega: 3.12345678 };
        return { grid_ms: now - (287 - i) * 15 * MIN, sampled_ms: now - (287 - i) * 15 * MIN, fut_price: 100_000 + i, data_ok: true, call: leg, put: leg, fut_long_pnl: 123.45678901234567, fut_short_pnl: -123.45678901234567 };
      }),
    };
    const body = await pulseScore(slot);
    expect(body.minute!.length).toBeGreaterThan(2800);
    expect(body.minute!.at(-1)!.r).not.toBeNull();
    expect(body.points.length).toBe(192);
    expect(body.pnl.length).toBe(288);
    const size = JSON.stringify(body).length;
    console.log(`[score] whole body ${size} bytes, minute ${JSON.stringify(body.minute).length} bytes`);
    expect(size).toBeLessThan(400_000);
  });

  it('sends trigger only on the points where it is on', async () => {
    process.env.PULSE_MINUTE_LANE = 'true';
    const now = Date.now();
    const slotMs = now - 3 * HOUR;
    h.cohorts = [cohort(slotMs)];
    h.rows = minuteRowsFor(slotMs, 20, now).map((r, i) => ({ ...r, fut_price: 100_000, put_mid: 100, call_mid: i >= 17 ? 120 : 100 }));
    const body = await pulseScore(slot);
    expect(body.minute!.at(-1)!.trigger).toBe(true);
    expect(body.minute![0]).not.toHaveProperty('trigger');
  });

  it('passes a NO DATA 15-minute point through, so the lane agrees with the card at once', async () => {
    process.env.PULSE_MINUTE_LANE = 'true';
    const now = Date.now();
    const slotMs = now - 3 * HOUR;
    h.cohorts = [cohort(slotMs)];
    h.rows = minuteRowsFor(slotMs, 30, now);
    const point = { verdict: 'SELL NOW', rawZone: 'sell', gateBlocked: false, vetoes: [], why: [], flips: null, heavyLeg: null, parts: null };
    h.full = {
      readings: [
        { ...point, t: now - 40 * MIN, zone: 'sell', confidence: 90 },
        { ...point, t: now - 10 * MIN, zone: 'nodata', verdict: 'NO DATA', rawZone: 'nodata', confidence: null },
      ],
      pnlRows: [],
    };
    const body = await pulseScore(slot);
    const m = body.minute!;
    expect(m.find((p) => p.t === now - 11 * MIN)!.r).not.toBeNull();
    expect(m.find((p) => p.t === now - 10 * MIN)).toMatchObject({ z: 'nodata', r: null });
    expect(m.at(-1)).toMatchObject({ z: 'nodata', r: null });
  });

  it('passes the held zone to the minute block, so a held avoid never shows safer', async () => {
    process.env.PULSE_MINUTE_LANE = 'true';
    const now = Date.now();
    const slotMs = now - 3 * HOUR;
    h.cohorts = [cohort(slotMs)];
    h.rows = minuteRowsFor(slotMs, 20, now);
    h.full = {
      readings: [{ t: now - 25 * MIN, zone: 'avoid', verdict: 'AVOID', confidence: 90, rawZone: 'avoid', gateBlocked: false, vetoes: ['killer'], why: [], flips: null, heavyLeg: null, parts: null }],
      pnlRows: [],
    };
    const body = await pulseScore(slot);
    expect(body.minute!.length).toBe(20);
    expect(body.minute!.every((m) => m.z === 'avoid')).toBe(true);
  });
});
