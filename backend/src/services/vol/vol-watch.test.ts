import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({ pool: { query: async () => ({ rows: [] }) }, db: {} }));
vi.mock('../alert-service.js', () => ({ alertService: { sendNotification: async () => true } }));
vi.mock('../news/index.js', () => ({ newsWatcher: { raise: async () => ({}) } }));
vi.mock('../watch/sources.js', () => ({ watchService: { snapshotFor: () => null } }));
vi.mock('./vol-history.js', () => ({ volRead: async () => null, cachedBars1h: () => [] }));

const { VolWatch } = await import('./vol-watch.js');
import type { Bar, VolRead } from '../../lib/vol/regime.js';

const H = 3_600_000;
const T0 = Date.parse('2026-11-05T18:00:00Z');

function read(level: VolRead['compression']['level'], pct = 50): VolRead {
  return {
    asOf: T0, iv: { now: 45, pct, pct24hAgo: pct, regime: null, rule: null, low30: false, change24h: 0 },
    rv: { rv24: 30, rv6: 45, rv7d: 35, ivRv: 1.5, shortRising: false, band: '', bandRule: '' },
    sessions: (['Asia', 'London', 'NY'] as const).map((s) => ({ session: s, quietRun: 3, latest: null, quietBelow: 1, waveAbove: 2, dots: [] })),
    compression: { level, why: 'test', bbPct: 50, rangeAt20dLow: false }, deadIv: { dead: false, why: '' }, behaviour: null,
    wave: { step: 'Waiting', why: '', waveHigh: null }, gate: { block: false, reasons: [], sizeMult: 1, notes: [] },
  };
}
function bars(now: number, lastClose: number): Bar[] {
  const out: Bar[] = [];
  for (let t = now - 5 * 24 * H; t + H < now; t += H) out.push({ t, o: 100_000, h: 100_200, l: 99_800, c: 100_000 });
  out.push({ t: now - H, o: 100_000, h: Math.max(100_000, lastClose), l: 99_900, c: lastClose });
  return out;
}

function rig(opts: { inTrade: boolean }) {
  let now = T0, level: VolRead['compression']['level'] = 'Quiet', close = 100_000;
  const notes: string[] = [], trips: string[] = [];
  let saved: unknown = null;
  const w = new VolWatch({
    now: () => now, read: async () => read(level), bars: () => bars(now, close), inTrade: () => opts.inTrade,
    notify: async (a) => { notes.push(a.title); }, tripped: async (t) => { trips.push(t.direction); },
    load: async () => saved as never, save: async (s) => { saved = s; },
  });
  return { w, notes, trips, set: (l: typeof level, c: number) => { level = l; close = c; }, advance: (ms: number) => { now += ms; } };
}

describe('VolWatch', () => {
  it('announces a change once, not on every run', async () => {
    const r = rig({ inTrade: false });
    await r.w.tick();
    r.set('Coiled', 100_000); r.advance(5 * 60_000); await r.w.tick();
    r.advance(5 * 60_000); await r.w.tick();
    expect(r.notes).toEqual(['Market Coiled']);
  });

  it('tripwire: fires while in a trade, once per break, then waits out the cooldown', async () => {
    const r = rig({ inTrade: true });
    r.set('Coiled', 100_000); await r.w.tick();
    expect(r.trips).toEqual([]);
    r.set('Coiled', 101_000); r.advance(H); await r.w.tick();
    expect(r.trips).toEqual(['up']);
    r.advance(H); await r.w.tick();
    expect(r.trips).toEqual(['up']);
  });

  it('no open trade: no tripwire popup', async () => {
    const r = rig({ inTrade: false });
    r.set('Squeeze', 98_500); await r.w.tick();
    expect(r.trips).toEqual([]);
  });
});
