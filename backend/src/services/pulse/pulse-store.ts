import { pool } from '../../db/index.js';
import type { MarketRow } from '../../lib/pulse/metrics/market.js';
import type { CohortRow } from '../../lib/pulse/metrics/series.js';
import type { Slot } from '../../lib/pulse/grid.js';
import type { MinuteRow } from '../../lib/pulse/metrics/damage.js';
import type { BuiltSnapshot, LegName, LegRow, PulseCohort } from '../../lib/pulse/snapshot.js';

/**
 * Persistence for Strangle Pulse. Raw SQL, tables created idempotently on first use (same approach as
 * bot-store.ts), so enabling the collector never needs a manual migration step.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS pulse_cohorts (
  id uuid PRIMARY KEY,
  slot text NOT NULL,
  series_id text NOT NULL,
  slot_ms bigint NOT NULL,
  expiry_ms bigint NOT NULL,
  status text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  close_reason text,
  spot_entry numeric,
  fut_entry_bid numeric,
  fut_entry_ask numeric,
  call_symbol text,
  put_symbol text,
  call_strike numeric,
  put_strike numeric,
  call_bid numeric,
  put_bid numeric,
  call_mid numeric,
  put_mid numeric,
  call_delta numeric,
  put_delta numeric,
  call_theta numeric,
  put_theta numeric,
  call_iv numeric,
  put_iv numeric,
  call_gamma numeric,
  put_gamma numeric,
  call_vega numeric,
  put_vega numeric,
  call_oi_band numeric,
  put_oi_band numeric,
  fee jsonb NOT NULL,
  missing jsonb,
  call_sl_at timestamptz,
  put_sl_at timestamptz,
  net_pnl numeric,
  UNIQUE (slot, slot_ms)
);
CREATE INDEX IF NOT EXISTS pulse_cohorts_status_idx ON pulse_cohorts (status, slot);

CREATE TABLE IF NOT EXISTS pulse_leg_snapshots (
  cohort_id uuid NOT NULL,
  grid_ms bigint NOT NULL,
  sampled_ms bigint NOT NULL,
  leg text NOT NULL,
  minutes_since_entry numeric,
  strike numeric,
  expiry_ms bigint,
  bid numeric,
  ask numeric,
  mark numeric,
  mid numeric,
  delta numeric,
  gamma numeric,
  theta numeric,
  vega numeric,
  iv numeric,
  oi numeric,
  oi_band numeric,
  oi_change numeric,
  volume_raw numeric,
  volume_change numeric,
  net_pnl numeric,
  sl_hit boolean NOT NULL,
  data_ok boolean NOT NULL,
  PRIMARY KEY (cohort_id, grid_ms, leg)
);

CREATE TABLE IF NOT EXISTS pulse_cohort_snapshots (
  cohort_id uuid NOT NULL,
  grid_ms bigint NOT NULL,
  sampled_ms bigint NOT NULL,
  spot numeric,
  fut_price numeric,
  combined_premium numeric,
  combined_pnl numeric,
  pnl_pct numeric,
  net_delta numeric,
  fut_long_pnl numeric,
  fut_short_pnl numeric,
  data_ok boolean NOT NULL,
  PRIMARY KEY (cohort_id, grid_ms)
);

CREATE TABLE IF NOT EXISTS pulse_market_snapshots (
  grid_ms bigint NOT NULL,
  slot text NOT NULL,
  expiry_ms bigint NOT NULL,
  sampled_ms bigint NOT NULL,
  spot numeric NOT NULL,
  atm_iv numeric,
  call25_iv numeric,
  put25_iv numeric,
  rr25 numeric,
  PRIMARY KEY (grid_ms, slot)
);

CREATE TABLE IF NOT EXISTS pulse_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  slot text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS pulse_events_at_idx ON pulse_events (at);

CREATE TABLE IF NOT EXISTS pulse_minute (
  slot text NOT NULL,
  /** The cohort's slot_ms: it names the cohort within its slot, and is a number as MinuteRow.cohort_id is. */
  cohort_id bigint NOT NULL,
  t bigint NOT NULL,
  fut_price numeric,
  call_mid numeric,
  put_mid numeric,
  call_iv numeric,
  put_iv numeric,
  data_ok boolean NOT NULL,
  PRIMARY KEY (slot, cohort_id, t)
);
CREATE INDEX IF NOT EXISTS pulse_minute_slot_t_idx ON pulse_minute (slot, t);
`;

let schemaReady: Promise<void> | null = null;

export function ensurePulseSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool.query(DDL).then(() => undefined);
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  return schemaReady;
}

type Row = Record<string, unknown>;

/** pg returns numeric/bigint as strings; convert (null stays null). */
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const ms = (v: unknown): number | null => (v === null || v === undefined ? null : new Date(v as string | Date).getTime());

const COHORT_COLS = [
  'id', 'slot', 'series_id', 'slot_ms', 'expiry_ms', 'status', 'opened_at', 'closed_at', 'close_reason', 'spot_entry',
  'fut_entry_bid', 'fut_entry_ask', 'call_symbol', 'put_symbol', 'call_strike', 'put_strike', 'call_bid', 'put_bid',
  'call_mid', 'put_mid', 'call_delta', 'put_delta', 'call_theta', 'put_theta', 'call_iv', 'put_iv',
  'call_gamma', 'put_gamma', 'call_vega', 'put_vega', 'call_oi_band', 'put_oi_band', 'fee', 'missing',
  'call_sl_at', 'put_sl_at', 'net_pnl',
] as const;

const NUM_COHORT_COLS = [
  'spot_entry', 'fut_entry_bid', 'fut_entry_ask', 'call_strike', 'put_strike', 'call_bid', 'put_bid', 'call_mid', 'put_mid',
  'call_delta', 'put_delta', 'call_theta', 'put_theta', 'call_iv', 'put_iv', 'call_gamma', 'put_gamma', 'call_vega', 'put_vega',
  'call_oi_band', 'put_oi_band', 'net_pnl',
] as const;

/** Inserts a cohort. Returns false when one already exists for this (slot, slot_ms). */
export async function insertCohort(c: PulseCohort): Promise<boolean> {
  const tsCols = new Set(['opened_at', 'closed_at', 'call_sl_at', 'put_sl_at']);
  const jsonCols = new Set(['fee', 'missing']);
  const placeholders = COHORT_COLS.map((col, i) => {
    const p = `$${i + 1}`;
    if (tsCols.has(col)) return `to_timestamp(${p}::double precision / 1000.0)`;
    if (jsonCols.has(col)) return `${p}::jsonb`;
    return p;
  });
  const params = COHORT_COLS.map((col) => {
    const v = (c as unknown as Row)[col];
    if (jsonCols.has(col)) return v === null || v === undefined ? null : JSON.stringify(v);
    return v ?? null;
  });
  const r = await pool.query(
    `INSERT INTO pulse_cohorts (${COHORT_COLS.join(',')}) VALUES (${placeholders.join(',')}) ON CONFLICT DO NOTHING RETURNING id`,
    params as never,
  );
  return (r.rowCount ?? 0) > 0;
}

function toCohort(r: Row): PulseCohort {
  const out: Row = { ...r };
  for (const k of NUM_COHORT_COLS) out[k] = num(r[k]);
  out.slot_ms = Number(r.slot_ms);
  out.expiry_ms = Number(r.expiry_ms);
  out.opened_at = ms(r.opened_at);
  out.closed_at = ms(r.closed_at);
  out.call_sl_at = ms(r.call_sl_at);
  out.put_sl_at = ms(r.put_sl_at);
  return out as unknown as PulseCohort;
}

export async function liveCohorts(): Promise<PulseCohort[]> {
  const r = await pool.query(`SELECT * FROM pulse_cohorts WHERE status IN ('open', 'futures_only') ORDER BY slot_ms, slot`);
  return (r.rows as Row[]).map(toCohort);
}

/** A slot's newest cohorts, any status, newest first. */
export async function recentCohorts(slot: Slot, limit: number): Promise<PulseCohort[]> {
  const r = await pool.query('SELECT * FROM pulse_cohorts WHERE slot = $1 ORDER BY slot_ms DESC LIMIT $2', [slot, limit]);
  return (r.rows as Row[]).map(toCohort);
}

const LEG_COLS = [
  'cohort_id', 'grid_ms', 'sampled_ms', 'leg', 'minutes_since_entry', 'strike', 'expiry_ms', 'bid', 'ask', 'mark', 'mid', 'delta', 'gamma',
  'theta', 'vega', 'iv', 'oi', 'oi_band', 'oi_change', 'volume_raw', 'volume_change', 'net_pnl', 'sl_hit', 'data_ok',
] as const;

const COHORT_SNAP_COLS = [
  'cohort_id', 'grid_ms', 'sampled_ms', 'spot', 'fut_price', 'combined_premium', 'combined_pnl', 'pnl_pct', 'net_delta', 'fut_long_pnl',
  'fut_short_pnl', 'data_ok',
] as const;

function multiInsert(table: string, cols: readonly string[], rows: unknown[][]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = rows.map((row) => {
    const ph = row.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    return `(${ph.join(',')})`;
  });
  return { sql: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params };
}

/** Writes one snapshot: one multi-row statement per table, idempotent per (cohort, grid[, leg]). */
export async function insertSnapshot(s: BuiltSnapshot): Promise<void> {
  const legRows = (['call', 'put'] as const).map((w) => LEG_COLS.map((col) => (s.legs[w] as unknown as Row)[col] ?? null));
  const legStmt = multiInsert('pulse_leg_snapshots', LEG_COLS, legRows);
  await pool.query(legStmt.sql, legStmt.params as never);
  const cohortRow = COHORT_SNAP_COLS.map((col) => {
    if (col === 'cohort_id') return s.cohortId;
    if (col === 'grid_ms') return s.gridMs;
    return (s.cohort as unknown as Row)[col] ?? null;
  });
  const cStmt = multiInsert('pulse_cohort_snapshots', COHORT_SNAP_COLS, [cohortRow]);
  await pool.query(cStmt.sql, cStmt.params as never);
}

const MARKET_COLS = ['grid_ms', 'slot', 'expiry_ms', 'sampled_ms', 'spot', 'atm_iv', 'call25_iv', 'put25_iv', 'rr25'] as const;

/** Writes skew and term-structure rows in one statement, idempotent per (grid, slot). */
export async function insertMarketRows(rows: readonly MarketRow[]): Promise<void> {
  if (rows.length === 0) return;
  const stmt = multiInsert('pulse_market_snapshots', MARKET_COLS, rows.map((r) => MARKET_COLS.map((col) => r[col] ?? null)));
  await pool.query(stmt.sql, stmt.params as never);
}

function toMarketRow(r: Row): MarketRow {
  return {
    grid_ms: Number(r.grid_ms), slot: r.slot as Slot, expiry_ms: Number(r.expiry_ms), sampled_ms: Number(r.sampled_ms), spot: Number(r.spot),
    atm_iv: num(r.atm_iv), call25_iv: num(r.call25_iv), put25_iv: num(r.put25_iv), rr25: num(r.rr25),
  };
}

export async function marketRowsAt(gridMs: number): Promise<MarketRow[]> {
  const r = await pool.query('SELECT * FROM pulse_market_snapshots WHERE grid_ms = $1 ORDER BY slot', [gridMs]);
  return (r.rows as Row[]).map(toMarketRow);
}

/** The rows at the newest stored grid, or none before the first. */
export async function latestMarketRows(): Promise<MarketRow[]> {
  const r = await pool.query('SELECT * FROM pulse_market_snapshots WHERE grid_ms = (SELECT max(grid_ms) FROM pulse_market_snapshots) ORDER BY slot');
  return (r.rows as Row[]).map(toMarketRow);
}

const NUM_LEG_COLS = [
  'grid_ms', 'sampled_ms', 'minutes_since_entry', 'strike', 'expiry_ms', 'bid', 'ask', 'mark', 'mid', 'delta', 'gamma', 'theta', 'vega', 'iv',
  'oi', 'oi_band', 'oi_change', 'volume_raw', 'volume_change', 'net_pnl',
] as const;

function toLegRow(r: Row): LegRow {
  const leg: Row = { ...r };
  for (const k of NUM_LEG_COLS) leg[k] = num(r[k]);
  return leg as unknown as LegRow;
}

/** The most recent stored leg row per leg for a cohort (used for OI / volume change). */
export async function lastLegSnapshots(cohortId: string): Promise<Record<LegName, LegRow | undefined>> {
  const r = await pool.query(
    'SELECT DISTINCT ON (leg) * FROM pulse_leg_snapshots WHERE cohort_id = $1 ORDER BY leg, grid_ms DESC',
    [cohortId],
  );
  const out: Record<LegName, LegRow | undefined> = { call: undefined, put: undefined };
  for (const row of r.rows as Row[]) out[row.leg as LegName] = toLegRow(row);
  return out;
}

/** A cohort's stored grids, oldest first. Cohort rows are read first: they are written after their legs, so each has both. */
export async function cohortRows(cohortId: string): Promise<CohortRow[]> {
  return (await cohortRowsMany([cohortId])).get(cohortId) ?? [];
}

/** cohortRows for many cohorts in two queries; every id is a key, empty when it has no rows. */
export async function cohortRowsMany(ids: readonly string[]): Promise<Map<string, CohortRow[]>> {
  const out = new Map<string, CohortRow[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const snaps = await pool.query('SELECT * FROM pulse_cohort_snapshots WHERE cohort_id = ANY($1::uuid[]) ORDER BY grid_ms', [ids]);
  const legs = await pool.query('SELECT * FROM pulse_leg_snapshots WHERE cohort_id = ANY($1::uuid[])', [ids]);
  const byGrid = new Map<string, Partial<Record<LegName, LegRow>>>();
  for (const row of legs.rows as Row[]) {
    const leg = toLegRow(row);
    const key = leg.cohort_id + ':' + leg.grid_ms;
    byGrid.set(key, { ...byGrid.get(key), [leg.leg]: leg });
  }
  for (const r of snaps.rows as Row[]) {
    const grid = Number(r.grid_ms);
    const { call, put } = byGrid.get(String(r.cohort_id) + ':' + grid) ?? {};
    if (!call || !put) continue;
    out.get(String(r.cohort_id))?.push({
      grid_ms: grid, sampled_ms: Number(r.sampled_ms), spot: num(r.spot) as number, fut_price: num(r.fut_price) as number,
      net_delta: num(r.net_delta), fut_long_pnl: num(r.fut_long_pnl), fut_short_pnl: num(r.fut_short_pnl), data_ok: r.data_ok as boolean,
      call, put,
    });
  }
  return out;
}

/** Records the time a leg's stop was first hit. Never overwrites an earlier value. */
export async function markStop(cohortId: string, leg: LegName, atMs: number): Promise<void> {
  const col = leg === 'call' ? 'call_sl_at' : 'put_sl_at';
  await pool.query(
    `UPDATE pulse_cohorts SET ${col} = to_timestamp($2::double precision / 1000.0) WHERE id = $1 AND ${col} IS NULL`,
    [cohortId, atMs],
  );
}

export async function closeCohorts(ids: string[], reason: 'ROLL' | 'EXPIRED', atMs: number, netPnl: number | null): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE pulse_cohorts SET status = 'closed', close_reason = $2, closed_at = to_timestamp($3::double precision / 1000.0), net_pnl = $4
     WHERE id = ANY($1::uuid[]) AND status IN ('open', 'futures_only')`,
    [ids, reason, atMs, netPnl],
  );
}

/** Append-only event log. */
export async function logEvent(type: string, slot: string | null, detail: unknown): Promise<void> {
  await pool.query('INSERT INTO pulse_events (type, slot, detail) VALUES ($1, $2, $3::jsonb)', [
    type,
    slot,
    detail === undefined ? null : JSON.stringify(detail),
  ]);
}

/** The newest snapshot grid stored, or null before the first one. */
export async function latestGridMs(): Promise<number | null> {
  const r = await pool.query('SELECT max(grid_ms) AS grid FROM pulse_cohort_snapshots');
  return num((r.rows[0] as Row | undefined)?.grid);
}

/** True when a live cohort from before this grid has no cohort snapshot at it, as after a crash part-way through the grid. */
export async function gridIncomplete(gridMs: number): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM pulse_cohorts c WHERE c.status IN ('open', 'futures_only') AND c.slot_ms < $1
     AND NOT EXISTS (SELECT 1 FROM pulse_cohort_snapshots s WHERE s.cohort_id = c.id AND s.grid_ms = $1) LIMIT 1`,
    [gridMs],
  );
  return r.rows.length > 0;
}

/** The series of the newest cohort row per slot, whatever its status. */
export async function latestSeries(): Promise<Partial<Record<Slot, string>>> {
  const r = await pool.query('SELECT DISTINCT ON (slot) slot, series_id FROM pulse_cohorts ORDER BY slot, slot_ms DESC');
  const out: Partial<Record<Slot, string>> = {};
  for (const row of r.rows as Row[]) out[row.slot as Slot] = row.series_id as string;
  return out;
}

/** The newest slot_ms with any row for this slot, including no_valid_strikes, or null if it has none. */
export async function latestSlotMs(slot: Slot): Promise<number | null> {
  const r = await pool.query('SELECT max(slot_ms) AS slot_ms FROM pulse_cohorts WHERE slot = $1', [slot]);
  return num((r.rows[0] as Row | undefined)?.slot_ms);
}

/** The hours from fromMs on that already have a MISSED_OPEN event for this slot. */
export async function missedOpenSlots(slot: Slot, fromMs: number): Promise<Set<number>> {
  const r = await pool.query(
    `SELECT (detail->>'slotMs')::bigint AS slot_ms FROM pulse_events
     WHERE type = 'MISSED_OPEN' AND slot = $1 AND (detail->>'slotMs')::bigint >= $2`,
    [slot, fromMs],
  );
  return new Set((r.rows as Row[]).map((row) => Number(row.slot_ms)));
}

/** Whether the collector has created the tables the read routes use. Read routes check this because they must not run the DDL themselves. */
export async function pulseTablesExist(): Promise<boolean> {
  const r = await pool.query(`SELECT to_regclass('pulse_cohorts') IS NOT NULL AND to_regclass('pulse_market_snapshots') IS NOT NULL AS ready`);
  return (r.rows[0] as Row).ready === true;
}

export async function dbSizeBytes(): Promise<number> {
  const r = await pool.query('SELECT pg_database_size(current_database()) AS size');
  return Number((r.rows[0] as Row).size);
}

const MINUTE_COLS = ['slot', 'cohort_id', 't', 'fut_price', 'call_mid', 'put_mid', 'call_iv', 'put_iv', 'data_ok'] as const;

/** Writes the minute rows in one statement, idempotent per (slot, cohort, minute). */
export async function insertMinuteRows(rows: ReadonlyArray<MinuteRow & { slot: Slot }>): Promise<void> {
  if (rows.length === 0) return;
  const stmt = multiInsert('pulse_minute', MINUTE_COLS, rows.map((r) => MINUTE_COLS.map((col) => r[col] ?? null)));
  await pool.query(stmt.sql, stmt.params as never);
}

/** A slot's minute rows from fromMs on, oldest first. */
export async function minuteRows(slot: Slot, fromMs: number): Promise<MinuteRow[]> {
  const r = await pool.query('SELECT * FROM pulse_minute WHERE slot = $1 AND t >= $2 ORDER BY t, cohort_id', [slot, fromMs]);
  return (r.rows as Row[]).map((row) => ({
    t: Number(row.t), cohort_id: Number(row.cohort_id), fut_price: num(row.fut_price), call_mid: num(row.call_mid), put_mid: num(row.put_mid),
    call_iv: num(row.call_iv), put_iv: num(row.put_iv), data_ok: row.data_ok as boolean,
  }));
}

/** Deletes minute rows older than beforeMs. */
export async function pruneMinute(beforeMs: number): Promise<void> {
  await pool.query('DELETE FROM pulse_minute WHERE t < $1', [beforeMs]);
}
