import { describe, expect, it } from 'vitest';
import { DAY, H } from '../calendar/time.js';
import { initialState, stickyRegime, tripwire, volTransitions, type VolState } from './alerts.js';
import type { Bar, VolRead } from './regime.js';

const NOW = Date.parse('2026-11-05T18:00:00Z');

function read(over: { pct?: number | null; level?: VolRead['compression']['level']; rv6?: number; rv24?: number; rv7d?: number; quietRun?: number } = {}): VolRead {
  const q = over.quietRun ?? 0;
  return {
    asOf: NOW,
    iv: { now: 45, pct: over.pct === undefined ? 50 : over.pct, pct24hAgo: 50, regime: null, rule: null, low30: false, change24h: 0 },
    rv: { rv24: over.rv24 ?? 30, rv6: over.rv6 ?? 25, rv7d: over.rv7d ?? 35, ivRv: 1.5, shortRising: false, band: '1.3–1.8', bandRule: 'Normal' },
    sessions: (['Asia', 'London', 'NY'] as const).map((s) => ({ session: s, quietRun: s === 'London' ? q : 0, latest: null, quietBelow: 1, waveAbove: 2, dots: [] })),
    compression: { level: over.level ?? 'Normal', why: 'test', bbPct: 50, rangeAt20dLow: false },
    deadIv: { dead: false, why: '' }, behaviour: null, wave: { step: 'Waiting', why: '', waveHigh: null },
    gate: { block: false, reasons: [], sizeMult: 1, notes: [] },
  };
}

describe('stickyRegime (no flip-flop on a band edge)', () => {
  it('stays Core at 39.5 and 38.5; moves to Low only at 38 or below', () => {
    expect(stickyRegime('Core', 39.5)).toBe('Core');
    expect(stickyRegime('Core', 38.5)).toBe('Core');
    expect(stickyRegime('Core', 38)).toBe('Low');
    expect(stickyRegime('Low', 41)).toBe('Low');
    expect(stickyRegime('Low', 42)).toBe('Core');
  });
  it('a big jump moves at once', () => {
    expect(stickyRegime('Core', 95)).toBe('Crisis');
  });
});

describe('volTransitions', () => {
  const step = (s: VolState, r: VolRead, t: number) => volTransitions(s, r, t);

  it('the first reading only sets the state; no message', () => {
    const { state, alerts } = step(initialState(NOW), read({ pct: 50 }), NOW);
    expect(state.regime).toBe('Core');
    expect(alerts).toEqual([]);
  });

  it('Low → Core says tighten exits; Rich → Core says best sell window', () => {
    let s = step(initialState(NOW), read({ pct: 30 }), NOW).state;
    let a = step(s, read({ pct: 45 }), NOW + H);
    expect(a.alerts[0]!.message).toContain('tighten exits');
    s = { ...a.state, regime: 'Rich' };
    a = step(s, read({ pct: 60 }), NOW + 2 * H);
    expect(a.alerts[0]!.title).toBe('Best sell window: IV falling from Rich into Core');
  });

  it('wobbling on the 40 edge sends nothing', () => {
    let s = step(initialState(NOW), read({ pct: 41 }), NOW).state;
    const sent: string[] = [];
    for (const [k, p] of [39.4, 40.6, 39.1, 40.9, 39.6].entries()) { const r = step(s, read({ pct: p }), NOW + (k + 1) * H); s = r.state; sent.push(...r.alerts.map((x) => x.title)); }
    expect(sent).toEqual([]);
  });

  it('Crisis → Rich, then 24 h later with RV falling: one "first sellable window"', () => {
    let s = step(initialState(NOW), read({ pct: 95 }), NOW).state;
    let r = step(s, read({ pct: 80 }), NOW + H); s = r.state;
    expect(r.alerts[0]!.title).toBe('IV regime Crisis → Rich');
    r = step(s, read({ pct: 80, rv24: 30, rv7d: 40 }), NOW + 10 * H); s = r.state;
    expect(r.alerts).toEqual([]);
    r = step(s, read({ pct: 80, rv24: 30, rv7d: 40 }), NOW + 26 * H); s = r.state;
    expect(r.alerts.map((x) => x.title)).toEqual(['First sellable window after the crisis']);
    r = step(s, read({ pct: 80, rv24: 30, rv7d: 40 }), NOW + 30 * H);
    expect(r.alerts).toEqual([]);
  });

  it('three weeks of Low IV: one "compression building"', () => {
    let s = step(initialState(NOW), read({ pct: 30 }), NOW).state;
    let all: string[] = [];
    for (let d = 1; d <= 25; d++) { const r = step(s, read({ pct: 30 }), NOW + d * DAY); s = r.state; all = all.concat(r.alerts.map((x) => x.title)); }
    expect(all).toEqual(['Compression building']);
  });

  it('Coiled and Squeeze are announced, and so is the end of the silence', () => {
    let s = step(initialState(NOW), read({ level: 'Quiet' }), NOW).state;
    let r = step(s, read({ level: 'Coiled' }), NOW + H); s = r.state;
    expect(r.alerts[0]!.title).toBe('Market Coiled');
    r = step(s, read({ level: 'Squeeze' }), NOW + 2 * H); s = r.state;
    expect(r.alerts[0]!.title).toBe('Market Squeeze');
    r = step(s, read({ level: 'Normal' }), NOW + 3 * H);
    expect(r.alerts[0]!.title).toBe('Silence broken: Squeeze → Normal');
  });
});

describe('tripwire', () => {
  function flat(lastClose: number): Bar[] {
    const out: Bar[] = [];
    for (let t = NOW - 5 * DAY; t + H < NOW; t += H) out.push({ t, o: 100_000, h: 100_200, l: 99_800, c: 100_000 });
    out.push({ t: NOW - H, o: 100_000, h: Math.max(100_000, lastClose), l: Math.min(100_000, lastClose), c: lastClose });
    return out;
  }
  it('only exists while Coiled or in a Squeeze', () => {
    expect(tripwire(read({ level: 'Normal' }), flat(100_000), NOW)).toBeNull();
    const t = tripwire(read({ level: 'Squeeze', quietRun: 5 }), flat(100_000), NOW)!;
    expect([t.hi, t.lo, t.broken]).toEqual([100_200, 99_800, null]);
  });
  it('a close above the quiet range with RV expanding is a break', () => {
    expect(tripwire(read({ level: 'Coiled', quietRun: 3, rv6: 40, rv24: 30 }), flat(100_900), NOW)!.broken).toBe('up');
    expect(tripwire(read({ level: 'Coiled', quietRun: 3, rv6: 40, rv24: 30 }), flat(99_100), NOW)!.broken).toBe('down');
  });
  it('a close outside without RV expanding is not (a wick on a quiet night)', () => {
    expect(tripwire(read({ level: 'Coiled', quietRun: 3, rv6: 20, rv24: 30 }), flat(100_900), NOW)!.broken).toBeNull();
  });
});
