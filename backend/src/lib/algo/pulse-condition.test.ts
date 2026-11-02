import { describe, expect, it } from 'vitest';
import { evalConditions, PULSE_MAX_AGE_MS, type MarketView, type PulseView } from './conditions.js';
import { conditionSchema } from './rule.js';
import { pulseSlotOf } from '../../services/algo/algo-engine.js';

const NOW = 1_800_000_000_000;
const view = (pulse?: PulseView | null): MarketView => ({ spot: 80_000, dvol: 50, gateGo: true, gateReasons: [], premium: 100, bars5m: [], nowMs: NOW, pulse });
const reading = (zone: PulseView['zone'], ageMs = 60_000): PulseView => ({ zone, risk: zone === 'nodata' ? null : 20, t: NOW - ageMs });
const passes = (zone: 'sell' | 'not_avoid', pulse?: PulseView | null) => evalConditions([{ type: 'pulse', zone }], view(pulse)).met;

describe('pulse condition', () => {
  it('SELL zone passes only on a fresh SELL reading', () => {
    expect(passes('sell', reading('sell'))).toBe(true);
    expect(passes('sell', reading('caution'))).toBe(false);
    expect(passes('sell', reading('avoid'))).toBe(false);
  });

  it('not-AVOID passes on SELL and CAUTION', () => {
    expect(passes('not_avoid', reading('sell'))).toBe(true);
    expect(passes('not_avoid', reading('caution'))).toBe(true);
    expect(passes('not_avoid', reading('avoid'))).toBe(false);
  });

  it('never passes without a fresh reading', () => {
    for (const zone of ['sell', 'not_avoid'] as const) {
      expect(passes(zone, undefined)).toBe(false);
      expect(passes(zone, null)).toBe(false);
      expect(passes(zone, reading('nodata'))).toBe(false);
      expect(passes(zone, reading('sell', PULSE_MAX_AGE_MS + 1))).toBe(false);
    }
  });

  it('shows the reading in the panel', () => {
    expect(evalConditions([{ type: 'pulse', zone: 'sell' }], view(reading('sell'))).results[0].now).toBe('SELL, Risk 20');
    expect(evalConditions([{ type: 'pulse', zone: 'sell' }], view(null)).results[0].now).toBe('no fresh reading');
  });

  it('the schema takes only the two choices', () => {
    expect(conditionSchema.safeParse({ type: 'pulse', zone: 'sell' }).success).toBe(true);
    expect(conditionSchema.safeParse({ type: 'pulse', zone: 'avoid' }).success).toBe(false);
  });

  it('reads the strategy expiry, and a fixed expiry has no slot', () => {
    const cond = [{ type: 'pulse', zone: 'sell' }] as never;
    const rule = (mode: string) => ({ expiry: { mode } }) as never;
    expect(pulseSlotOf(rule('next'), cond)).toBe('next');
    expect(pulseSlotOf(rule('n2n'), cond)).toBe('n2n');
    expect(pulseSlotOf(rule('current'), cond)).toBe('current');
    expect(pulseSlotOf(rule('fixed'), cond)).toBeUndefined();
    expect(pulseSlotOf(rule('next'), [])).toBeUndefined();
  });
});
