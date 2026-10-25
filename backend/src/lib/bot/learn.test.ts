import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARAMS, evaluateStrategy, gatePasses, inCooldown, maxDrawdown, normalUpperTail, pairedStats, sanitizeParams, simulateExit,
  type RunTrace,
} from './learn.js';
import type { Leg } from './types.js';

const EXP = Date.parse('2026-10-30T12:00:00Z');
const legs: Leg[] = [
  { symbol: 'C', type: 'call', side: 'short', strike: 82000, expiryMs: EXP, lots: 100, entryPrice: 100, role: 'body' },
  { symbol: 'P', type: 'put', side: 'short', strike: 79000, expiryMs: EXP, lots: 100, entryPrice: 100, role: 'body' },
];

const dayKey = (i: number) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

/** call/put mark paths, one entry per minute; the time exit is the last minute. */
function trace(i: number, call: number[], put: number[], over: Partial<RunTrace> = {}): RunTrace {
  const t0 = Date.UTC(2026, 0, 1 + i, 4, 30);
  return {
    strategy: 'ASIA_SHORT', dateKey: dayKey(i), marginUsd: 100, feesEntry: 1, feesExit: 1, dvol: 40, macroZone: 'calm', legs,
    exitAtMs: t0 + (call.length - 1) * 60_000,
    minutes: call.map((c, k) => ({ t: t0 + k * 60_000, spot: 80_000, marks: [c, put[k]!] })),
    complete: true, ...over,
  };
}

// A spike to 2.1x then a reversal and a profit: the 2x stop takes the loss, a wider stop takes the win.
const SPIKE = { call: [100, 100, 210, 150, 60, 20, 20], put: [100, 90, 80, 80, 60, 40, 40] };
// A flat day: nothing triggers, so every rule set behaves the same.
const CALM = { call: [100, 100, 100, 100, 100, 100, 100], put: [100, 100, 100, 100, 100, 100, 100] };
// A spike that keeps going: widening the stop only makes it worse.
const BLOWUP = { call: [100, 100, 210, 300, 400, 500, 500], put: [100, 100, 100, 100, 100, 100, 100] };

const days = (n: number, spikeEvery: number) =>
  Array.from({ length: n }, (_, i) => trace(i, i % spikeEvery === 0 ? SPIKE.call : CALM.call, i % spikeEvery === 0 ? SPIKE.put : CALM.put, { feesExit: 1 + 0.01 * (i % 5) }));

describe('simulateExit', () => {
  it('the 2x stop closes everything on the spike; a 3x stop rides it out to the take-profit', () => {
    const tight = simulateExit(trace(0, SPIKE.call, SPIKE.put), { stopMultiple: 2, tpPct: 0.1 })!;
    // call 100 -> 210 = -11, put 100 -> 80 = +2, entry fee 1, exit fee 1
    expect(tight).toBeCloseTo(-11 + 2 - 1 - 1, 6);
    const wide = simulateExit(trace(0, SPIKE.call, SPIKE.put), { stopMultiple: 3, tpPct: 0.1 })!;
    expect(wide).toBeGreaterThan(5);
  });

  it('runs to the end of the data (the time exit) when nothing triggers, and returns null with no data', () => {
    const calm = trace(0, [100, 99, 98], [100, 99, 98]);
    expect(simulateExit(calm, { stopMultiple: 2, tpPct: 0.5 })).toBeCloseTo((2 + 2) * 0.1 - 1 - 1, 6);
    expect(simulateExit({ ...calm, minutes: [] }, { stopMultiple: 2, tpPct: 0.1 })).toBeNull();
  });
});

describe('statistics', () => {
  it('normal tail, drawdown and paired stats behave', () => {
    expect(normalUpperTail(0)).toBeCloseTo(0.5, 4);
    expect(normalUpperTail(1.645)).toBeCloseTo(0.05, 3);
    expect(maxDrawdown([5, -3, -4, 10, -1])).toBe(7);
    const s = pairedStats([2, 3, 2, 4, 3], [1, 1, 1, 1, 1]);
    expect(s.meanDiff).toBeCloseTo(1.8, 9);
    expect(s.p).toBeLessThan(0.01);
    expect(pairedStats([1, 1], [1, 1]).p).toBe(1);
  });

  it('gate passes only below the DVOL limit and in a calm macro zone', () => {
    expect(gatePasses({ dvol: 50, macroZone: 'calm' }, 65)).toBe(true);
    expect(gatePasses({ dvol: 70, macroZone: 'calm' }, 65)).toBe(false);
    expect(gatePasses({ dvol: 50, macroZone: 'stress' }, 65)).toBe(false);
    expect(gatePasses({ dvol: null, macroZone: 'calm' }, 65)).toBe(false);
  });
});

describe('evaluateStrategy', () => {
  it('promotes a wider stop when it clearly beats the champion over enough days', () => {
    const ev = evaluateStrategy('ASIA_SHORT', days(60, 3), DEFAULT_PARAMS);
    expect(ev.days).toBe(60);
    expect(ev.promote).not.toBeNull();
    expect(ev.promote!.experiment).toBe('exit');
    expect(ev.promote!.changed).toBe('stopMultiple');
    expect(ev.promote!.to.stopMultiple).toBeGreaterThan(2);
    expect(ev.promote!.reason).toMatch(/stopMultiple 2 -> /);
    expect(ev.promote!.reason).toMatch(/corrected threshold met/);
    // exactly one knob changes
    expect({ ...ev.promote!.to, stopMultiple: 2 }).toEqual(DEFAULT_PARAMS);
  });

  it('never promotes on too few days, however good it looks', () => {
    const ev = evaluateStrategy('ASIA_SHORT', days(20, 2), DEFAULT_PARAMS);
    expect(ev.promote).toBeNull();
    const wide = ev.challengers.find((c) => c.changed === 'stopMultiple' && c.params.stopMultiple === 3)!;
    expect(wide.failed.join(' ')).toMatch(/only 20 days/);
  });

  it('does not promote when the rules make no difference', () => {
    const ev = evaluateStrategy('ASIA_SHORT', days(60, 1000).slice(1), DEFAULT_PARAMS);
    expect(ev.promote).toBeNull();
  });

  it('ignores incomplete traces (data that stops before the planned exit)', () => {
    const partial = days(60, 3).map((t) => ({ ...t, complete: false }));
    const ev = evaluateStrategy('ASIA_SHORT', partial, DEFAULT_PARAMS);
    expect(ev.days).toBe(0);
    expect(ev.promote).toBeNull();
  });

  it('promotes a tighter DVOL gate when high-DVOL days are the losing ones', () => {
    const champion = { ...DEFAULT_PARAMS, dvolMax: 80 };
    const ts = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0
        ? trace(i, BLOWUP.call, BLOWUP.put, { dvol: 72, feesExit: 1 + 0.01 * (i % 5) }) // high-vol days that blow through every stop
        : trace(i, CALM.call, CALM.put, { dvol: 40 }),
    );
    const ev = evaluateStrategy('ASIA_SHORT', ts, champion);
    expect(ev.promote).not.toBeNull();
    expect(ev.promote!.experiment).toBe('gate');
    expect(ev.promote!.changed).toBe('dvolMax');
    expect(ev.promote!.to.dvolMax).toBeLessThan(72);
    expect(ev.promote!.to.dvolMax).toBeGreaterThanOrEqual(45);
  });
});

describe('guards', () => {
  it('cooldown blocks a second promotion inside two weeks', () => {
    const now = Date.parse('2026-10-25T00:00:00Z');
    expect(inCooldown(now - 5 * 86_400_000, now)).toBe(true);
    expect(inCooldown(now - 15 * 86_400_000, now)).toBe(false);
    expect(inCooldown(null, now)).toBe(false);
  });

  it('stored params outside the tested grid fall back to the defaults', () => {
    expect(sanitizeParams({ stopMultiple: 99, tpPct: 0.15, dvolMax: 12 })).toEqual({ dvolMax: 65, stopMultiple: 2, tpPct: 0.15 });
    expect(sanitizeParams(null)).toEqual(DEFAULT_PARAMS);
  });
});
