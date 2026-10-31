import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { BuiltSnapshot, LegRow, PulseCohort } from '../lib/pulse/snapshot.js';
import type { MarketRow } from '../lib/pulse/metrics/market.js';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));

vi.mock('../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) {
        const res = await h.db.exec(text);
        const last = res[res.length - 1];
        return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 };
      }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));

const store = await import('../services/pulse/pulse-store.js');
const { pulseRoutes } = await import('./pulse.js');
const { pool } = await import('../db/index.js');

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const AUTH = { authorization: 'x' };
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

function cohort(n: number, over: Partial<PulseCohort> = {}): PulseCohort {
  const slotMs = T0 + n * HOUR;
  return {
    id: uuid(n), slot: 'current', series_id: 's1', slot_ms: slotMs, expiry_ms: T0 + 48 * HOUR, status: 'open',
    opened_at: slotMs, closed_at: null, close_reason: null, spot_entry: 100000, fut_entry_bid: 100000, fut_entry_ask: 100000,
    call_symbol: 'C', put_symbol: 'P', call_strike: 105000, put_strike: 95000,
    call_bid: 95, put_bid: 95, call_mid: 100, put_mid: 100, call_delta: 0.2, put_delta: 0.2,
    call_theta: -240, put_theta: -240, call_iv: 50, put_iv: 50, call_gamma: 0, put_gamma: 0, call_vega: 0, put_vega: 0,
    call_oi_band: 10, put_oi_band: 10, fee: { takerRate: 0, makerRate: 0, premiumCapRate: 0, contractValue: 0.001 }, missing: null,
    call_sl_at: null, put_sl_at: null, net_pnl: null, ...over,
  };
}

function leg(id: string, which: 'call' | 'put', grid: number, mid: number): LegRow {
  return {
    cohort_id: id, grid_ms: grid, sampled_ms: grid, leg: which, minutes_since_entry: 15, strike: 100000, expiry_ms: T0 + 48 * HOUR,
    bid: mid - 1, ask: mid + 1, mark: mid, mid, delta: 0.2, gamma: 0, theta: -240, vega: 0, iv: 50,
    oi: 10, oi_band: 10, oi_change: 0, volume_raw: 1, volume_change: 0, net_pnl: 0, sl_hit: false, data_ok: true,
  };
}

function snap(c: PulseCohort, minutes: number, winner: 'long' | 'short' | null, ok = true, mid = 90): BuiltSnapshot {
  const grid = c.slot_ms + minutes * 60_000;
  return {
    cohortId: c.id, gridMs: grid,
    cohort: {
      sampled_ms: grid, spot: 100000, fut_price: 100100, combined_premium: null, combined_pnl: null, pnl_pct: null, net_delta: 0.01,
      fut_long_pnl: winner === 'long' ? 5 : 1, fut_short_pnl: winner === 'short' ? 5 : 1, data_ok: ok,
    },
    legs: { call: leg(c.id, 'call', grid, mid), put: leg(c.id, 'put', grid, mid) },
  };
}

const market = (slot: MarketRow['slot'], atm: number | null, rr: number | null, grid = T0): MarketRow => ({
  grid_ms: grid, slot, expiry_ms: T0 + 48 * HOUR, sampled_ms: grid, spot: 100000, atm_iv: atm, call25_iv: null, put25_iv: null, rr25: rr,
});

let app: FastifyInstance;

beforeAll(async () => {
  h.db = new PGlite() as never;
  await store.ensurePulseSchema();
  app = fastify({ logger: false });
  app.decorate('authenticate', async (req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!req.headers.authorization) return reply.code(401).send({ success: false });
  });
  await app.register(pulseRoutes, { prefix: '/api/v1/pulse' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await (h.db as unknown as PGlite).close();
});
beforeEach(async () => {
  await pool.query('DELETE FROM pulse_leg_snapshots; DELETE FROM pulse_cohort_snapshots; DELETE FROM pulse_cohorts; DELETE FROM pulse_market_snapshots;');
});

const get = (slot: string) => app.inject({ method: 'GET', url: `/api/v1/pulse/metrics?slot=${slot}`, headers: AUTH });

describe('GET /pulse/metrics', () => {
  it('401 without a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/pulse/metrics?slot=current' })).statusCode).toBe(401);
  });

  it('bad or missing slot gives 400', async () => {
    expect((await get('bogus')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/pulse/metrics', headers: AUTH })).statusCode).toBe(400);
  });

  it('empty database gives the empty shape', async () => {
    const res = await get('n2n');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      success: true, slot: 'n2n', cohorts: [], persistence: null, skew: { rr25: null, atm_iv: null }, term_inverted: null, gex: { available: false },
    });
  });

  it('a database with no pulse tables yet gives the empty shape and creates nothing', async () => {
    const real = h.db;
    const fresh = new PGlite();
    h.db = fresh as never;
    try {
      const res = await get('current');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ cohorts: [], persistence: null, term_inverted: null });
      const t = await fresh.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE 'pulse_%'`);
      expect((t.rows[0] as { n: number }).n).toBe(0);
    } finally {
      h.db = real;
      await fresh.close();
    }
  });

  it('lists only open cohorts, newest first, each with its latest good step', async () => {
    const closed = cohort(1, { status: 'closed' });
    const older = cohort(2);
    const newer = cohort(3);
    const noRows = cohort(4);
    const other = cohort(5, { slot: 'next' });
    for (const c of [closed, older, newer, noRows, other]) await store.insertCohort(c);
    await store.insertSnapshot(snap(older, 15, null));
    await store.insertSnapshot(snap(newer, 15, null, true, 90));
    await store.insertSnapshot(snap(newer, 30, null, false, 40)); // bad: not the latest good step
    const body = (await get('current')).json();
    expect(body.success).toBe(true);
    expect(body.cohorts.map((c: { id: string }) => c.id)).toEqual([noRows.id, newer.id, older.id]);
    expect(body.cohorts[0]).toEqual({ id: noRows.id, slot_ms: noRows.slot_ms, latest: null });
    expect(body.cohorts[1].slot_ms).toBe(newer.slot_ms);
    expect(body.cohorts[1].latest.sampled_ms).toBe(newer.slot_ms + 15 * 60_000);
    expect(body.cohorts[1].latest.de_call).toBeCloseTo(4, 6); // (100-90) / (240 x 15/1440 = 2.5)
  });

  it('persistence uses each of the newest 6 usable cohorts of this slot, any status', async () => {
    // Oldest first. Counting the oldest here would give 5; counting the no_valid_strikes rows as the window would give 3.
    const sides = ['long', 'short', 'long', 'long', 'long', 'long', 'short'] as const;
    for (let i = 0; i < sides.length; i++) {
      const c = cohort(i, { status: i < 3 ? 'closed' : 'open' });
      await store.insertCohort(c);
      await store.insertSnapshot(snap(c, 15, sides[i]));
      await store.insertSnapshot(snap(c, 30, i === 6 ? 'long' : sides[i], false)); // bad, and for i=6 the wrong side
    }
    await store.insertCohort(cohort(20, { status: 'no_valid_strikes' }));
    await store.insertCohort(cohort(21, { status: 'no_valid_strikes' }));
    const other = cohort(22, { slot: 'next' });
    await store.insertCohort(other);
    await store.insertSnapshot(snap(other, 15, 'long'));
    // Newest 6 usable: short, long, long, long, long, short.
    const body = (await get('current')).json();
    expect(body.persistence).toEqual({ side: 'long', count: 4 });
  });

  it('reports the skew of the requested slot and the term structure of current and next', async () => {
    await store.insertMarketRows([market('current', 60, -2), market('next', 55, 1), market('n2n', 50, 3)]);
    await store.insertMarketRows([market('current', 40, 9, T0 - HOUR), market('next', 80, 9, T0 - HOUR)]);
    const body = (await get('n2n')).json();
    expect(body.skew).toEqual({ rr25: 3, atm_iv: 50 });
    expect(body.term_inverted).toBe(true); // 60 > 55 at the newest grid, whatever the slot asked for
    expect(body.gex).toEqual({ available: false });
  });

  it('skew is null for a slot missing from the newest grid, and term with a missing side', async () => {
    await store.insertMarketRows([market('current', 60, -2)]);
    const body = (await get('next')).json();
    expect(body.skew).toEqual({ rr25: null, atm_iv: null });
    expect(body.term_inverted).toBeNull();
  });
});
