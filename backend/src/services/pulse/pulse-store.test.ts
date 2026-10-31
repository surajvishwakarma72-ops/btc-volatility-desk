import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { BuiltSnapshot, LegRow, PulseCohort } from '../../lib/pulse/snapshot.js';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));

vi.mock('../../db/index.js', () => ({
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

const store = await import('./pulse-store.js');
const { pool } = await import('../../db/index.js');
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params as never)).rows as any[];

const SLOT = Date.parse('2026-10-31T08:00:00Z');
const EXP = Date.parse('2026-10-31T12:00:00Z');
const GRID = SLOT + 15 * 60_000;

function mk(over: Partial<PulseCohort> = {}): PulseCohort {
  return {
    id: '11111111-1111-1111-1111-111111111111', slot: 'current', series_id: 's1', slot_ms: SLOT, expiry_ms: EXP, status: 'open',
    opened_at: SLOT + 1000, closed_at: null, close_reason: null, spot_entry: 80000.5, fut_entry_bid: 79990, fut_entry_ask: 80010,
    call_symbol: 'C-1', put_symbol: 'P-1', call_strike: 82000, put_strike: 78000,
    call_bid: 100, put_bid: 90, call_mid: 101, put_mid: 91, call_delta: 0.12, put_delta: 0.13,
    call_theta: -5, put_theta: -4, call_iv: 40, put_iv: 41,
    fee: { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 }, missing: null,
    call_sl_at: null, put_sl_at: null, net_pnl: null, ...over,
  };
}

function leg(which: 'call' | 'put', over: Partial<LegRow> = {}): LegRow {
  return {
    cohort_id: mk().id, grid_ms: GRID, leg: which, minutes_since_entry: 15, strike: 82000, expiry_ms: EXP,
    bid: 70, ask: 80, mark: 75, mid: 75, delta: 0.1, gamma: 1e-5, theta: -5, vega: 2, iv: 40,
    oi: 10, oi_band: 50, oi_change: null, volume_raw: 7, volume_change: null, net_pnl: 0.01, sl_hit: false, data_ok: true, ...over,
  };
}

function snap(grid = GRID): BuiltSnapshot {
  return {
    cohortId: mk().id, gridMs: grid,
    cohort: { spot: 80100, fut_price: 80110, combined_premium: 145, combined_pnl: 0.02, pnl_pct: 10, net_delta: -0.05, fut_long_pnl: 1, fut_short_pnl: -1, data_ok: true },
    legs: { call: leg('call', { grid_ms: grid }), put: leg('put', { grid_ms: grid }) },
  };
}

beforeAll(async () => {
  h.db = new PGlite() as never;
  await store.ensurePulseSchema();
});
afterAll(async () => {
  await (h.db as unknown as PGlite).close();
});
beforeEach(async () => {
  await pool.query('DELETE FROM pulse_leg_snapshots; DELETE FROM pulse_cohort_snapshots; DELETE FROM pulse_events; DELETE FROM pulse_cohorts;');
});

describe('pulse-store', () => {
  it('ensurePulseSchema is idempotent', async () => {
    await store.ensurePulseSchema();
    await store.ensurePulseSchema();
  });

  it('insertCohort twice for one slot_ms stores one row', async () => {
    expect(await store.insertCohort(mk())).toBe(true);
    expect(await store.insertCohort(mk({ id: '22222222-2222-2222-2222-222222222222' }))).toBe(false);
    expect((await q('SELECT count(*)::int AS n FROM pulse_cohorts'))[0].n).toBe(1);
  });

  it('insertSnapshot twice for one grid stores one set of rows', async () => {
    await store.insertCohort(mk());
    await store.insertSnapshot(snap());
    await store.insertSnapshot(snap());
    expect((await q('SELECT count(*)::int AS n FROM pulse_leg_snapshots'))[0].n).toBe(2);
    expect((await q('SELECT count(*)::int AS n FROM pulse_cohort_snapshots'))[0].n).toBe(1);
  });

  it('liveCohorts returns only open cohorts with numbers, not strings', async () => {
    await store.insertCohort(mk());
    await store.insertCohort(mk({ id: '33333333-3333-3333-3333-333333333333', slot: 'next', status: 'closed' }));
    const live = await store.liveCohorts();
    expect(live).toHaveLength(1);
    const c = live[0]!;
    expect(c.slot_ms).toBe(SLOT);
    expect(c.expiry_ms).toBe(EXP);
    expect(c.opened_at).toBe(SLOT + 1000);
    expect(c.call_bid).toBe(100);
    expect(c.spot_entry).toBe(80000.5);
    expect(c.call_sl_at).toBeNull();
    expect(c.fee.contractValue).toBe(0.001);
  });

  it('lastLegSnapshots returns the latest row per leg as numbers', async () => {
    await store.insertCohort(mk());
    await store.insertSnapshot(snap(GRID));
    const later = snap(GRID + 900_000);
    later.legs.call.oi_band = 77;
    await store.insertSnapshot(later);
    const last = await store.lastLegSnapshots(mk().id);
    expect(last.call?.grid_ms).toBe(GRID + 900_000);
    expect(last.call?.oi_band).toBe(77);
    expect(last.call?.expiry_ms).toBe(EXP);
    expect(last.put?.volume_raw).toBe(7);
    expect(await store.lastLegSnapshots('99999999-9999-9999-9999-999999999999')).toEqual({ call: undefined, put: undefined });
  });

  it('markStop sets the stop time once and never overwrites it', async () => {
    await store.insertCohort(mk());
    await store.markStop(mk().id, 'put', GRID);
    await store.markStop(mk().id, 'put', GRID + 900_000);
    const c = (await store.liveCohorts())[0]!;
    expect(c.put_sl_at).toBe(GRID);
    expect(c.call_sl_at).toBeNull();
  });

  it('closeCohorts closes open cohorts with reason and P&L', async () => {
    await store.insertCohort(mk());
    await store.closeCohorts([mk().id], 'ROLL', GRID, 0.5);
    const r = (await q('SELECT status, close_reason, net_pnl, closed_at FROM pulse_cohorts'))[0];
    expect(r.status).toBe('closed');
    expect(r.close_reason).toBe('ROLL');
    expect(Number(r.net_pnl)).toBe(0.5);
    expect(new Date(r.closed_at).getTime()).toBe(GRID);
    expect(await store.liveCohorts()).toHaveLength(0);
    await store.closeCohorts([], 'ROLL', GRID, 0);
  });

  it('logEvent appends rows', async () => {
    await store.logEvent('open_failed', 'next', { why: 'no chain' });
    await store.logEvent('open_failed', null, { why: 'again' });
    const rows = await q('SELECT type, slot, detail FROM pulse_events ORDER BY id');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'open_failed', slot: 'next', detail: { why: 'no chain' } });
    expect(rows[1].slot).toBeNull();
  });

  it('latestGridMs is null when empty, then the newest stored grid as a number', async () => {
    expect(await store.latestGridMs()).toBeNull();
    await store.insertCohort(mk());
    await store.insertSnapshot(snap(GRID + 900_000));
    await store.insertSnapshot(snap(GRID));
    expect(await store.latestGridMs()).toBe(GRID + 900_000);
  });

  it('latestSeries returns the series of the newest cohort per slot, any status', async () => {
    expect(await store.latestSeries()).toEqual({});
    await store.insertCohort(mk({ series_id: 'old' }));
    await store.insertCohort(mk({ id: '44444444-4444-4444-4444-444444444444', slot_ms: SLOT + 3_600_000, series_id: 'new', status: 'no_valid_strikes' }));
    await store.insertCohort(mk({ id: '55555555-5555-5555-5555-555555555555', slot: 'n2n', series_id: 'other' }));
    expect(await store.latestSeries()).toEqual({ current: 'new', n2n: 'other' });
  });

  it('gridIncomplete is true only for an open cohort from before the grid with no row at it', async () => {
    const later = '66666666-6666-6666-6666-666666666666';
    const closed = '77777777-7777-7777-7777-777777777777';
    await store.insertCohort(mk({ id: later, slot: 'next', slot_ms: GRID })); // not before the grid
    await store.insertCohort(mk({ id: closed, slot: 'n2n', status: 'closed' }));
    expect(await store.gridIncomplete(GRID)).toBe(false);
    await store.insertCohort(mk());
    expect(await store.gridIncomplete(GRID)).toBe(true);
    await store.insertSnapshot(snap(GRID));
    expect(await store.gridIncomplete(GRID)).toBe(false);
  });

  it('hasCohort matches on slot and slot_ms, any status', async () => {
    await store.insertCohort(mk({ status: 'no_valid_strikes' }));
    expect(await store.hasCohort('current', SLOT)).toBe(true);
    expect(await store.hasCohort('next', SLOT)).toBe(false);
    expect(await store.hasCohort('current', SLOT + 3_600_000)).toBe(false);
  });

  it('dbSizeBytes returns a positive number', async () => {
    const n = await store.dbSizeBytes();
    expect(typeof n).toBe('number');
    expect(n).toBeGreaterThan(0);
  });
});
