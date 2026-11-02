import { describe, expect, it } from 'vitest';
import { damageAt, triggerStep, type Entry, type MinuteRow, type SideDamage, type TriggerState } from './damage.js';

const T0 = Date.UTC(2026, 10, 2, 10, 0, 0);
const row = (min: number, o: Partial<MinuteRow> = {}): MinuteRow => ({
  t: T0 + min * 60_000, cohort_id: 1, fut_price: 100_000, call_mid: 100, put_mid: 100, call_iv: 50, put_iv: 50, data_ok: true, ...o,
});
const entry: Entry = { call: 100, put: 100 };

describe('damageAt', () => {
  it('premium up 10% of entry for a 2% move: ratio 5, score 0', () => {
    const d = damageAt(row(5, { put_mid: 110, fut_price: 102_000 }), [row(0)], entry)!;
    expect(d.put!.premiumUpPct).toBeCloseTo(10);
    expect(d.put!.ratio).toBeCloseTo(5);
    expect(d.put!.score).toBeCloseTo(0);
  });
  it('premium up 30% of entry for a 1% move: ratio 30, score 100', () => {
    const d = damageAt(row(5, { put_mid: 130, fut_price: 101_000 }), [row(0)], entry)!;
    expect(d.put!.ratio).toBeCloseTo(30);
    expect(d.put!.score).toBeCloseTo(100);
    expect(d.movePct).toBeCloseTo(1);
  });
  it('premium falling is zero damage', () => {
    const d = damageAt(row(5, { put_mid: 90 }), [row(0)], entry)!;
    expect(d.put!.premiumUpPct).toBe(0);
    expect(d.put!.score).toBe(0);
  });
  it('uses the 0.02% floor on a flat market', () => {
    const d = damageAt(row(5, { put_mid: 101 }), [row(0)], entry)!;
    expect(d.put!.ratio).toBeCloseTo(50);
    expect(d.put!.score).toBe(100);
  });
  it('never compares two positions', () => {
    expect(damageAt(row(5), [row(0, { cohort_id: 2 })], entry)).toBeNull();
  });
  it('is null across a gap', () => {
    expect(damageAt(row(20), [row(0)], entry)).toBeNull();
    expect(damageAt(row(5), [row(0, { data_ok: false })], entry)).toBeNull();
  });
  it('tolerates one minute either way', () => {
    expect(damageAt(row(5), [row(1)], entry)).not.toBeNull();
    expect(damageAt(row(5), [row(-2)], entry)).toBeNull();
  });
  it('is null when the futures price is unusable on either row', () => {
    expect(damageAt(row(5, { put_mid: 130, fut_price: null }), [row(0)], entry)).toBeNull();
    expect(damageAt(row(5, { put_mid: 130 }), [row(0, { fut_price: null })], entry)).toBeNull();
  });
  it('a side with a missing mid or non-positive entry is null', () => {
    const d = damageAt(row(5, { call_mid: null }), [row(0)], { call: 100, put: 0 })!;
    expect(d.call).toBeNull();
    expect(d.put).toBeNull();
  });
});

const side = (premiumUpPct: number, score: number) => ({ premiumUpPct, ratio: 0, score });
const dmg = (put: SideDamage['put'], call: SideDamage['call'] = null): SideDamage => ({ call, put, movePct: 0 });
const OFF: TriggerState = { above: 0, below: 0, on: false, side: null };

describe('triggerStep', () => {
  it('a wobble scoring 100 does not fire', () => {
    let s = OFF;
    for (let i = 0; i < 5; i++) s = triggerStep(s, dmg(side(1, 100)));
    expect(s.on).toBe(false);
  });
  it('fires after 2 minutes per side', () => {
    let s = triggerStep(OFF, dmg(side(10, 100)));
    expect(s.on).toBe(false);
    s = triggerStep(s, dmg(side(10, 100)));
    expect(s.on).toBe(true);
    expect(s.side).toBe('put');
  });
  it('clears after 10 minutes below', () => {
    let s = triggerStep(triggerStep(OFF, dmg(side(10, 100))), dmg(side(10, 100)));
    for (let i = 0; i < 9; i++) s = triggerStep(s, dmg(side(0, 0)));
    expect(s.on).toBe(true);
    s = triggerStep(s, dmg(side(0, 0)));
    expect(s.on).toBe(false);
  });
  it('null damage counts as below', () => {
    let s = triggerStep(OFF, dmg(side(10, 100)));
    s = triggerStep(s, null);
    s = triggerStep(s, dmg(side(10, 100)));
    expect(s.on).toBe(false);
  });
});
