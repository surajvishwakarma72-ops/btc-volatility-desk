import { describe, expect, it } from 'vitest';
import type { Entry, MinuteRow } from '../metrics/damage.js';
import { minuteReadings, type BasePoint } from './minute.js';

const MIN = 60_000;
const COH = 900_000;
const entries = new Map<number, Entry>([[COH, { call: 100, put: 100 }]]);
const row = (i: number, o: Partial<MinuteRow> = {}): MinuteRow => ({
  t: i * MIN, cohort_id: COH, fut_price: 100_000, call_mid: 100, put_mid: 100, call_iv: 50, put_iv: 50, data_ok: true, ...o,
});
const flat = (n: number, o: (i: number) => Partial<MinuteRow> = () => ({})) => Array.from({ length: n }, (_, i) => row(i, o(i)));
const base = (c: number, call = 50, put = 50): BasePoint[] => [{ t: 0, c, call, put }];

describe('minuteReadings', () => {
  it('blends 70% of held Risk and 30% of the worse side', () => {
    const p = minuteReadings(flat(7, (i) => (i === 6 ? { call_mid: 110 } : {})), entries, base(60))[6]!;
    expect(p.r).toBeCloseTo(58);
    expect(p.hurt).toBe('call');
  });

  it('holds a base point for at most 30 minutes', () => {
    const pts = minuteReadings(flat(32), entries, base(60));
    expect(pts[30]!.r).not.toBeNull();
    expect(pts[31]!.r).toBeNull();
    expect(pts[31]!.z).toBe('nodata');
  });

  it('caps at WAIT with no damage', () => {
    const pts = minuteReadings(flat(3), entries, base(90));
    expect(pts[0]!.r).toBeCloseTo(10);
    expect(pts.every((p) => p.z === 'caution')).toBe(true);
  });

  it('needs 5 readings to change zone', () => {
    const pts = minuteReadings(flat(10), entries, base(90));
    // Damage exists from minute 4 (one minute tolerance); raw zone is sell from then on.
    for (let i = 0; i <= 7; i++) expect(pts[i]!.z).toBe('caution');
    expect(pts[8]!.z).toBe('sell');
  });

  const spike = (i: number) => (i === 6 || i === 7 ? { call_mid: 110 } : {});

  it('the trigger goes straight to avoid', () => {
    const pts = minuteReadings(flat(9, spike), entries, base(100));
    expect(pts[6]!.trigger).toBe(false);
    expect(pts[6]!.z).toBe('caution');
    expect(pts[7]!.trigger).toBe(true);
    expect(pts[7]!.z).toBe('avoid');
  });

  it('returns through the normal rule when the trigger clears', () => {
    const pts = minuteReadings(flat(23, spike), entries, base(100));
    expect(pts[16]!.trigger).toBe(true);
    expect(pts[17]!.trigger).toBe(false);
    expect(pts[17]!.z).toBe('avoid');
    expect(pts[20]!.z).toBe('avoid');
    expect(pts[21]!.z).toBe('sell');
  });

  it('Call is 60% damage and 40% the held line', () => {
    const p = minuteReadings(flat(7, (i) => (i === 6 ? { call_mid: 110 } : {})), entries, base(60, 50, 50))[6]!;
    expect(p.call).toBeCloseTo(0.6 * 100 + 0.4 * 50);
    expect(p.put).toBeCloseTo(0.4 * 50);
  });

  it('Call is null when its damage is missing', () => {
    const p = minuteReadings(flat(7, (i) => (i === 6 ? { call_mid: null } : {})), entries, base(60))[6]!;
    expect(p.call).toBeNull();
    expect(p.put).not.toBeNull();
  });

  it('futures read the signed 60-minute move', () => {
    const rows = flat(61, (i) => (i === 60 ? { fut_price: 100_500 } : {}));
    const p = minuteReadings(rows, entries, base(60))[60]!;
    expect(p.fl).toBeCloseTo(50);
    expect(p.fs).toBe(0);
    const d = minuteReadings(flat(61, (i) => (i === 60 ? { fut_price: 99_500 } : {})), entries, base(60))[60]!;
    expect(d.fl).toBe(0);
    expect(d.fs).toBeCloseTo(50);
    expect(minuteReadings(rows, entries, base(60))[58]!.fl).toBeNull();
  });

  it('makes no point for a missing minute', () => {
    const pts = minuteReadings([row(0), row(2)], entries, base(60));
    expect(pts.map((p) => p.t)).toEqual([0, 2 * MIN]);
  });

  it('futures keep reading with no strangle', () => {
    const rows = flat(61, (i) => (i === 60 ? { fut_price: 100_500 } : {}));
    const p = minuteReadings(rows, new Map(), [])[60]!;
    expect(p.r).toBeNull();
    expect(p.z).toBe('nodata');
    expect(p.fl).toBeCloseTo(50);
  });

  it('falls back to the older cohort when the newest has no damage', () => {
    const NEW = COH + 3_600_000;
    const ents = new Map<number, Entry>([[COH, { call: 100, put: 100 }], [NEW, { call: 100, put: 100 }]]);
    const rows = [...flat(6), row(6, { call_mid: 110 }), row(6, { cohort_id: NEW, call_mid: 110 })];
    const p = minuteReadings(rows, ents, base(60))[6]!;
    expect(p.hurt).toBe('call');
  });
});
