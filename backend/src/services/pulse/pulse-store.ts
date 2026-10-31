import { pool } from '../../db/index.js';
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

CREATE TABLE IF NOT EXISTS pulse_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  slot text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS pulse_events_at_idx ON pulse_events (at);
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
  'call_mid', 'put_mid', 'call_delta', 'put_delta', 'call_theta', 'put_theta', 'call_iv', 'put_iv', 'fee', 'missing',
  'call_sl_at', 'put_sl_at', 'net_pnl',
] as const;

const NUM_COHORT_COLS = [
  'spot_entry', 'fut_entry_bid', 'fut_entry_ask', 'call_strike', 'put_strike', 'call_bid', 'put_bid', 'call_mid', 'put_mid',
  'call_delta', 'put_delta', 'call_theta', 'put_theta', 'call_iv', 'put_iv', 'net_pnl',
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
  const r = await pool.query(`SELECT * FROM pulse_cohorts WHERE status = 'open' ORDER BY slot_ms, slot`);
  return (r.rows as Row[]).map(toCohort);
}

const LEG_COLS = [
  'cohort_id', 'grid_ms', 'leg', 'minutes_since_entry', 'strike', 'expiry_ms', 'bid', 'ask', 'mark', 'mid', 'delta', 'gamma',
  'theta', 'vega', 'iv', 'oi', 'oi_band', 'oi_change', 'volume_raw', 'volume_change', 'net_pnl', 'sl_hit', 'data_ok',
] as const;

const COHORT_SNAP_COLS = [
  'cohort_id', 'grid_ms', 'spot', 'fut_price', 'combined_premium', 'combined_pnl', 'pnl_pct', 'net_delta', 'fut_long_pnl',
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

const NUM_LEG_COLS = [
  'grid_ms', 'minutes_since_entry', 'strike', 'expiry_ms', 'bid', 'ask', 'mark', 'mid', 'delta', 'gamma', 'theta', 'vega', 'iv',
  'oi', 'oi_band', 'oi_change', 'volume_raw', 'volume_change', 'net_pnl',
] as const;

/** The most recent stored leg row per leg for a cohort (used for OI / volume change). */
export async function lastLegSnapshots(cohortId: string): Promise<Record<LegName, LegRow | undefined>> {
  const r = await pool.query(
    'SELECT DISTINCT ON (leg) * FROM pulse_leg_snapshots WHERE cohort_id = $1 ORDER BY leg, grid_ms DESC',
    [cohortId],
  );
  const out: Record<LegName, LegRow | undefined> = { call: undefined, put: undefined };
  for (const row of r.rows as Row[]) {
    const leg: Row = { ...row };
    for (const k of NUM_LEG_COLS) leg[k] = num(row[k]);
    out[row.leg as LegName] = leg as unknown as LegRow;
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
     WHERE id = ANY($1::uuid[]) AND status = 'open'`,
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

export async function dbSizeBytes(): Promise<number> {
  const r = await pool.query('SELECT pg_database_size(current_database()) AS size');
  return Number((r.rows[0] as Row).size);
}
