import { describe, expect, it } from 'vitest';
import { leadReport } from './lead-test.js';
import type { Entry, MinuteRow } from './metrics/damage.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 2, 0, 0, 0);
const entry: Entry = { call: 100, put: 100 }; // entry premium 200, so a jump is +40

interface Spec { put: (m: number) => number; fut?: (m: number) => number; minutes?: number }
function cohort(id: number, startMs: number, s: Spec): MinuteRow[] {
  const rows: MinuteRow[] = [];
  for (let m = 0; m < (s.minutes ?? 60); m++) {
    rows.push({
      t: startMs + m * 60_000, cohort_id: id, fut_price: s.fut ? s.fut(m) : 100_000,
      call_mid: 100, put_mid: s.put(m), call_iv: 50, put_iv: 50, data_ok: true,
    });
  }
  return rows;
}
const entriesFor = (ids: number[]) => new Map<number, Entry>(ids.map((i) => [i, entry]));
const one = (s: Spec) => ({ rows: cohort(1, T0, s), entries: entriesFor([1]) });

describe('leadReport jumps', () => {
  it('a jump is premium up 20% of entry within 30 minutes', () => {
    const jump = (rise: number, over: number) => one({ put: (m) => 100 + Math.min(1, Math.max(0, (m - 10) / over)) * rise });
    const hit = jump(40, 10);
    expect(leadReport(hit.rows, hit.entries).jumps).toBe(1);
    const small = jump(39, 10);
    expect(leadReport(small.rows, small.entries).jumps).toBe(0);
    const slow = jump(40, 31);
    expect(leadReport(slow.rows, slow.entries).jumps).toBe(0);
  });
});

describe('leadReport readings', () => {
  it('a high reading is a damage score of 100', () => {
    // premium up 0.7% of entry in 5 minutes on a flat market scores exactly 100; 0.4% does not
    const high = one({ put: (m) => (m >= 30 ? 100.7 : 100) });
    expect(leadReport(high.rows, high.entries).damage.readings).toBe(1);
    const low = one({ put: (m) => (m >= 30 ? 100.4 : 100) });
    expect(leadReport(low.rows, low.entries).damage.readings).toBe(0);
  });
  it('merges consecutive readings within 30 minutes into one episode', () => {
    const r = one({ put: (m) => (m >= 30 ? 100 + (m - 29) * 2 : 100), minutes: 50 });
    expect(leadReport(r.rows, r.entries).damage.readings).toBe(1);
  });
  it('never counts a jump before its reading', () => {
    // the rise starts at minute 24; the first reading is at minute 29, so the jump is already under way
    const r = one({ put: (m) => (m < 24 ? 100 : Math.min(148, 100 + (m - 24) * 8)), minutes: 45 });
    const rep = leadReport(r.rows, r.entries);
    expect(rep.jumps).toBe(1);
    expect(rep.damage.readings).toBe(1);
    expect(rep.damage.hits.m30).toBe(0);
    expect(rep.damage.falseAlarmRate).toBe(1);
  });
});

/** 21 daily cohorts. Damage reading at minute 30, the premium dips back, then jumps at minute 45 (its start is minute 44). */
function manyDays(n: number, spec: Spec) {
  const ids: number[] = [];
  const rows: MinuteRow[] = [];
  for (let d = 0; d < n; d++) {
    ids.push(d + 1);
    rows.push(...cohort(d + 1, T0 + d * DAY, spec));
  }
  return { rows, entries: entriesFor(ids) };
}
const jumpAt45 = (m: number) => (m >= 45 ? 145 : m >= 30 && m < 35 ? 100.7 : 100);

describe('leadReport verdict', () => {
  it('says not enough data under 14 days or 20 jumps', () => {
    const fewDays = manyDays(10, { put: jumpAt45 });
    expect(leadReport(fewDays.rows, fewDays.entries).verdict).toBe('not enough data');
    const fewJumps = manyDays(15, { put: jumpAt45 });
    const rep = leadReport(fewJumps.rows, fewJumps.entries);
    expect(rep.jumps).toBe(15);
    expect(rep.verdict).toBe('not enough data');
  });
  it('says leads only when damage beats plain BTC movement', () => {
    // BTC jumps at minute 50, after the jump has begun, so it never leads; damage reads at minute 30
    const d = manyDays(21, { put: jumpAt45, fut: (m) => (m >= 50 ? 101_000 : 100_000) });
    const rep = leadReport(d.rows, d.entries);
    expect(rep.jumps).toBe(21);
    expect(rep.damage.readings).toBe(21);
    expect(rep.damage.hits.m30).toBe(21);
    expect(rep.damage.hits.m5).toBe(0);
    expect(rep.damage.medianLeadMin).toBe(14);
    expect(rep.btc.hits.m30).toBe(0);
    expect(rep.verdict).toBe('leads');
  });
  it('says does not lead when plain BTC movement does as well or better', () => {
    // BTC moves at minute 32 with no earlier damage reading, then the jump starts at minute 39
    const d = manyDays(21, { put: (m) => (m >= 45 ? 145 : 100), fut: (m) => (m >= 32 ? 101_000 : 100_000) });
    const rep = leadReport(d.rows, d.entries);
    expect(rep.damage.hits.m30).toBe(0); // its only readings come once the jump is under way
    expect(rep.btc.hits.m30).toBeGreaterThan(0);
    expect(rep.verdict).toBe('does not lead');
  });
  it('says not enough data when damage has too few episodes, even with enough days and jumps', () => {
    const rows: MinuteRow[] = [];
    const ids: number[] = [];
    for (let d = 0; d < 21; d++) {
      ids.push(d + 1);
      // first 5 days: a damage reading then a jump. Others: a slow ramp with BTC moving along, so damage stays low.
      rows.push(...cohort(d + 1, T0 + d * DAY, d < 5
        ? { put: jumpAt45 }
        : { put: (m) => 100 + Math.min(40, Math.max(0, (m - 10) * (40 / 30))), fut: (m) => 100_000 * (1 + 0.005 * Math.min(30, Math.max(0, m - 10))) }));
    }
    const rep = leadReport(rows, entriesFor(ids));
    expect(rep.jumps).toBeGreaterThanOrEqual(20);
    expect(rep.days).toBeGreaterThanOrEqual(14);
    expect(rep.damage.readings).toBeLessThan(20);
    expect(rep.verdict).toBe('not enough data');
  });
  it('measures the day span of 200,000 rows without spreading them', () => {
    const rows: MinuteRow[] = [];
    for (let i = 0; i < 200_000; i++) {
      rows.push({ t: T0 + i * 60_000, cohort_id: 0, fut_price: null, call_mid: null, put_mid: null, call_iv: null, put_iv: null, data_ok: false });
    }
    const rep = leadReport(rows, new Map());
    expect(rep.days).toBeCloseTo(199_999 / 1440);
    expect(rep.verdict).toBe('not enough data');
  });
});
