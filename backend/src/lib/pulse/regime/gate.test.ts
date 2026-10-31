import { describe, expect, it } from 'vitest';
import { REGIME_GATE_CONFIG as C } from '../config.js';
import { evaluateRegimeGate, type GateInputs } from './gate.js';
import type { RegimeState } from './indicators.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

/** RV24 that yields exactly the requested IV/RV ratio for a DVOL. */
const rvFor = (dvol: number, ratio: number) => (dvol * C.ivScaleK) / 100 / ratio;

const state = (o: Partial<RegimeState> = {}): RegimeState => ({
  adx: 20, adxPrev: 19, adxUp: false, rvp: 0.4, rvpPrev: 0.5, rvpUp: false, killer: false, rv7: 0.5, ...o,
});

function inputs(o: Partial<GateInputs> = {}): GateInputs {
  return {
    nowMs: NOW,
    dvol: { value: 50, at: NOW },
    barsNewestOpenMs: NOW - HOUR,
    state: state(),
    rv24: rvFor(50, 1.5),
    macro: { hasData: true, status: 'ok', nextEvent: 'No Tier-1 US news in 6h' },
    ...o,
  };
}

const get = (r: ReturnType<typeof evaluateRegimeGate>, id: string) => r.inputs.find((x) => x.id === id)!;

describe('evaluateRegimeGate', () => {
  it('passes with no reasons when every tested input is ok', () => {
    const r = evaluateRegimeGate(inputs());
    expect(r.pass).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.gateId).toBe('spec-adx25');
    expect(r.asOf).toBe(NOW);
  });

  it.each([
    ['ADX exactly 25', { state: state({ adx: 25 }) }, false],
    ['ADX 24.99', { state: state({ adx: 24.99 }) }, true],
    ['IV/RV exactly 1.3', { rv24: rvFor(50, 1.3) }, false],
    ['IV/RV 1.31', { rv24: rvFor(50, 1.31) }, true],
    ['DVOL exactly 65', { dvol: { value: 65, at: NOW }, rv24: rvFor(65, 1.5) }, false],
    ['DVOL 64.9', { dvol: { value: 64.9, at: NOW }, rv24: rvFor(64.9, 1.5) }, true],
    ['killer true', { state: state({ killer: true }) }, false],
  ] as const)('%s', (_n, o, expected) => {
    const r = evaluateRegimeGate(inputs(o as Partial<GateInputs>));
    expect(r.pass).toBe(expected);
    if (!expected) expect(r.reasons).toHaveLength(1);
  });

  it('exact IV/RV boundary really equals the threshold', () => {
    const r = evaluateRegimeGate(inputs({ rv24: rvFor(50, 1.3) }));
    expect(Math.abs((get(r, 'iv_rv').value as number) - 1.3)).toBeLessThan(1e-9);
  });

  it('killer null gives pass null and killer unavailable', () => {
    const r = evaluateRegimeGate(inputs({ state: state({ killer: null }) }));
    expect(r.pass).toBeNull();
    expect(get(r, 'killer').available).toBe(false);
    expect(r.reasons).toEqual(['Killer unavailable: killer flag not computable']);
  });

  it('stale bars (3h) make adx, killer and iv_rv unavailable', () => {
    const r = evaluateRegimeGate(inputs({ barsNewestOpenMs: NOW - 3 * HOUR }));
    expect(r.pass).toBeNull();
    for (const id of ['adx', 'killer', 'iv_rv']) {
      expect(get(r, id).available).toBe(false);
      expect(get(r, id).note).toBe('hourly bars stale or missing');
    }
    expect(r.reasons).toContain('ADX unavailable: hourly bars stale or missing');
  });

  it('missing bars timestamp is unavailable', () => {
    const r = evaluateRegimeGate(inputs({ barsNewestOpenMs: null }));
    expect(r.pass).toBeNull();
    expect(get(r, 'adx').available).toBe(false);
  });

  it('DVOL 11 minutes old is unavailable; null DVOL too', () => {
    const old = evaluateRegimeGate(inputs({ dvol: { value: 50, at: NOW - 11 * 60_000 } }));
    expect(old.pass).toBeNull();
    expect(get(old, 'dvol').available).toBe(false);
    expect(get(old, 'dvol').note).toBe('DVOL older than 10 minutes');
    expect(get(old, 'iv_rv').available).toBe(false);
    const none = evaluateRegimeGate(inputs({ dvol: null }));
    expect(none.pass).toBeNull();
    expect(get(none, 'dvol').available).toBe(false);
  });

  it('ADX failing plus DVOL unavailable is false with two reasons', () => {
    const r = evaluateRegimeGate(inputs({ state: state({ adx: 31.2 }), dvol: null }));
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('ADX 31.2 is not below 25');
    expect(r.reasons).toContain('DVOL unavailable: DVOL missing');
    expect(r.reasons.filter((x) => x.startsWith('ADX') || x.startsWith('DVOL'))).toHaveLength(2);
  });

  it('null rv24 makes iv_rv unavailable', () => {
    const r = evaluateRegimeGate(inputs({ rv24: null }));
    expect(get(r, 'iv_rv').available).toBe(false);
    expect(r.pass).toBeNull();
  });

  it('macro event sets blackout without changing pass', () => {
    const base = evaluateRegimeGate(inputs());
    const ev = evaluateRegimeGate(inputs({ macro: { hasData: true, status: 'ok', nextEvent: 'US CPI Release (in 2h)' } }));
    expect(ev.blackout).toBe(true);
    expect(ev.pass).toBe(base.pass);
    expect(get(ev, 'events').ok).toBe(false);
    expect(get(ev, 'events').tested).toBe(false);
    expect(base.blackout).toBe(false);
    expect(get(base, 'events').ok).toBe(true);
  });

  it.each([
    ['degraded', { hasData: true, status: 'degraded' as const, nextEvent: 'x' }],
    ['no data', { hasData: false, status: 'ok' as const, nextEvent: 'x' }],
    ['null', null],
  ])('macro %s gives blackout null', (_n, macro) => {
    const r = evaluateRegimeGate(inputs({ macro }));
    expect(r.blackout).toBeNull();
    expect(get(r, 'events').available).toBe(false);
    expect(r.pass).toBe(true);
  });

  it('gex and deribit_expiry are always unavailable, inputs in fixed order', () => {
    const r = evaluateRegimeGate(inputs());
    expect(r.inputs.map((x) => x.id)).toEqual(['iv_rv', 'adx', 'killer', 'dvol', 'events', 'gex', 'deribit_expiry']);
    for (const id of ['gex', 'deribit_expiry']) {
      const x = get(r, id);
      expect(x.available).toBe(false);
      expect(x.ok).toBeNull();
      expect(x.note).toBe('no data feed');
    }
  });
});
