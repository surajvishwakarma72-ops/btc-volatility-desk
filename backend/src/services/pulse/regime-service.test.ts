import { describe, expect, it } from 'vitest';
import { REGIME_GATE_CONFIG } from '../../lib/pulse/config.js';
import type { InputReading, RegimeGateResult } from '../../lib/pulse/regime/gate.js';
import { hourReturns, ivOverRv, regimeState, rvWindow, type Bar1h } from '../../lib/pulse/regime/indicators.js';
import { RegimeService, type RegimeDeps } from './regime-service.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const CALM = { hasData: true, status: 'ok' as const, nextEvent: 'No Tier-1 US news in 6h' };

// Same seeded generator as lib/pulse/regime/indicators.test.ts.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBars(n: number, start = T0): Bar1h[] {
  const rnd = mulberry32(12345);
  const bars: Bar1h[] = [];
  let px = 60000;
  for (let i = 0; i < n; i++) {
    const o = px;
    const ret = 0.003 * Math.sin(i / 17) + 0.008 * (rnd() - 0.5) * (1 + 0.6 * Math.sin(i / 300));
    const c = o * Math.exp(ret);
    const h = Math.max(o, c) * (1 + 0.003 * rnd());
    const l = Math.min(o, c) * (1 - 0.003 * rnd());
    bars.push({ t: start + i * HOUR, o, h, l, c });
    px = c;
  }
  return bars;
}

const BARS = makeBars(2600);
/** 20 minutes into the hour after the newest bar: every bar is complete. */
const NOW = BARS.at(-1)!.t + HOUR + 20 * 60_000;

function fakeBars(bars: Bar1h[]): RegimeDeps['bars'] {
  return {
    completed: (nowMs) => bars.filter((b) => b.t + HOUR <= nowMs),
    status: () => ({ count: bars.length, newestOpenMs: bars.at(-1)?.t ?? null, lastOkAt: null, lastError: null }),
  };
}

function deps(over: Partial<RegimeDeps> = {}): Partial<RegimeDeps> {
  return {
    bars: fakeBars(BARS),
    dvol: () => ({ value: 50, at: NOW - 60_000 }),
    macro: () => CALM,
    now: () => NOW,
    ...over,
  };
}

const input = (r: RegimeGateResult, id: string): InputReading => r.inputs.find((x) => x.id === id)!;

describe('RegimeService', () => {
  it('parity: ADX, killer and IV/RV equal direct calls of the indicator functions on the same bars', () => {
    const svc = new RegimeService(deps(), { minBars: 100 });
    const r = svc.snapshot();
    const state = regimeState(BARS, NOW)!;
    const rv24 = rvWindow(hourReturns(BARS, NOW), NOW, REGIME_GATE_CONFIG.rvHours);
    expect(state.adx).not.toBeNull();
    expect(state.killer).not.toBeNull();
    expect(rv24).not.toBeNull();
    expect(input(r, 'adx').value).toBe(state.adx);
    expect(input(r, 'killer').value).toBe(state.killer);
    expect(input(r, 'iv_rv').value).toBe(ivOverRv((50 * REGIME_GATE_CONFIG.ivScaleK) / 100, rv24));
    expect(input(r, 'dvol').value).toBe(50);
    expect(r.asOf).toBe(NOW);
    expect(r.bars.count).toBe(2600);
    expect(r.pass).not.toBeNull();
  });

  it('defaults minBars to 8928 (372 days)', () => {
    expect(REGIME_GATE_CONFIG.minBars).toBe(8928);
  });

  it('fewer completed bars than minBars gives pass null with every bar input unavailable', () => {
    const fresh = makeBars(2000, NOW - 2000 * HOUR - 20 * 60_000);
    const r = new RegimeService(deps({ bars: fakeBars(fresh) })).snapshot();
    expect(r.pass).toBeNull();
    for (const id of ['iv_rv', 'adx', 'killer']) {
      expect(input(r, id).available).toBe(false);
      expect(input(r, id).note).toBe('hourly bars stale or missing');
    }
    expect(input(r, 'dvol').available).toBe(true);
  });

  it('empty bars give pass null and bar-based inputs unavailable', () => {
    const r = new RegimeService(deps({ bars: fakeBars([]) }), { minBars: 100 }).snapshot();
    expect(r.pass).toBeNull();
    for (const id of ['iv_rv', 'adx', 'killer']) expect(input(r, id).available).toBe(false);
    expect(r.bars.newestOpenMs).toBeNull();
  });

  it('bars whose newest open is 3 hours old give pass null', () => {
    const now = BARS.at(-1)!.t + 3 * HOUR;
    const r = new RegimeService(deps({ now: () => now, dvol: () => ({ value: 50, at: now }) }), { minBars: 100 }).snapshot();
    expect(r.pass).toBeNull();
    expect(input(r, 'adx').available).toBe(false);
    expect(input(r, 'adx').note).toBe('hourly bars stale or missing');
  });

  it('a DVOL reading older than dvolMaxAgeMs is unavailable', () => {
    const r = new RegimeService(deps({ dvol: () => ({ value: 50, at: NOW - REGIME_GATE_CONFIG.dvolMaxAgeMs - 1 }) }), { minBars: 100 }).snapshot();
    expect(input(r, 'dvol').available).toBe(false);
    expect(input(r, 'iv_rv').available).toBe(false);
    expect(new RegimeService(deps({ dvol: () => null }), { minBars: 100 }).snapshot().pass).not.toBe(true);
  });

  it('a macro blackout string sets blackout without changing pass', () => {
    const calm = new RegimeService(deps(), { minBars: 100 }).snapshot();
    const hot = new RegimeService(deps({ macro: () => ({ ...CALM, nextEvent: 'US CPI Release (in 1.5h IST)' }) }), { minBars: 100 }).snapshot();
    expect(calm.blackout).toBe(false);
    expect(hot.blackout).toBe(true);
    expect(hot.pass).toBe(calm.pass);
  });

  it('passes the macro loading state through unchanged (hasData false: unavailable, no blackout)', () => {
    const r = new RegimeService(deps({ macro: () => ({ hasData: false, status: 'degraded', nextEvent: 'loading' }) }), { minBars: 100 }).snapshot();
    expect(r.blackout).toBeNull();
    expect(input(r, 'events').available).toBe(false);
  });

  it('caches the result for 60 s per instance and recomputes after', () => {
    let now = NOW;
    let calls = 0;
    const bars = fakeBars(BARS);
    const svc = new RegimeService(deps({
      now: () => now,
      bars: { ...bars, completed: (n) => { calls++; return bars.completed(n); } },
    }), { minBars: 100 });
    const a = svc.snapshot();
    now = NOW + 59_999;
    expect(svc.snapshot()).toBe(a);
    expect(calls).toBe(1);
    now = NOW + 60_000;
    const b = svc.snapshot();
    expect(b).not.toBe(a);
    expect(b.asOf).toBe(NOW + 60_000);
    expect(calls).toBe(2);
  });
});
