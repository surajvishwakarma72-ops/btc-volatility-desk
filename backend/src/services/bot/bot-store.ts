import { pool } from '../../db/index.js';

/**
 * Persistence for the trading bot. Raw SQL on purpose: the bot tables are created idempotently
 * on first start (same approach as the other ad-hoc table scripts), so enabling the bot never
 * needs a manual migration step.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS bot_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_key text UNIQUE NOT NULL,
  strategy text NOT NULL,
  book text NOT NULL,
  mode text NOT NULL,
  date_key text NOT NULL,
  status text NOT NULL,
  entry_at timestamptz,
  exit_at timestamptz,
  planned_exit_at timestamptz,
  spot_entry numeric,
  margin_usd numeric,
  fees_entry numeric DEFAULT 0,
  fees_exit numeric DEFAULT 0,
  gross_pnl numeric,
  net_pnl numeric,
  peak_pnl numeric,
  trough_pnl numeric,
  exit_reason text,
  exit_detail text,
  exit_config jsonb,
  tags jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_runs_status_idx ON bot_runs (status);
CREATE INDEX IF NOT EXISTS bot_runs_strategy_idx ON bot_runs (strategy, entry_at);

CREATE TABLE IF NOT EXISTS bot_legs (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  type text NOT NULL,
  side text NOT NULL,
  role text NOT NULL,
  strike numeric NOT NULL,
  expiry_ms bigint NOT NULL,
  lots integer NOT NULL,
  entry_price numeric NOT NULL,
  exit_price numeric
);
CREATE INDEX IF NOT EXISTS bot_legs_run_idx ON bot_legs (run_id);

CREATE TABLE IF NOT EXISTS bot_fills (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
  leg_symbol text NOT NULL,
  action text NOT NULL,
  side text NOT NULL,
  lots integer NOT NULL,
  intended_price numeric,
  avg_price numeric,
  filled integer NOT NULL,
  partial boolean NOT NULL DEFAULT false,
  fee numeric NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_fills_run_idx ON bot_fills (run_id);

CREATE TABLE IF NOT EXISTS bot_minute_marks (
  run_id uuid NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
  minute_ms bigint NOT NULL,
  net_pnl numeric NOT NULL,
  gross_pnl numeric NOT NULL,
  pct_margin numeric NOT NULL,
  spot numeric NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (run_id, minute_ms)
);
CREATE INDEX IF NOT EXISTS bot_minute_marks_time_idx ON bot_minute_marks (minute_ms);

CREATE TABLE IF NOT EXISTS bot_minute_context (
  minute_ms bigint PRIMARY KEY,
  spot numeric,
  ctx jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  run_id uuid,
  strategy text,
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  data jsonb
);
CREATE INDEX IF NOT EXISTS bot_events_at_idx ON bot_events (at);
CREATE INDEX IF NOT EXISTS bot_events_run_idx ON bot_events (run_id);

CREATE TABLE IF NOT EXISTS bot_config (
  id integer PRIMARY KEY DEFAULT 1,
  paused boolean NOT NULL DEFAULT false,
  kill_switch boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bot_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

let schemaReady: Promise<void> | null = null;

export function ensureBotSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool.query(DDL).then(() => undefined);
    schemaReady.catch(() => {
      schemaReady = null;
    });
  }
  return schemaReady;
}

export interface RunRow {
  id: string;
  run_key: string;
  strategy: string;
  book: string;
  mode: string;
  date_key: string;
  status: string;
  entry_at: Date | null;
  exit_at: Date | null;
  planned_exit_at: Date | null;
  spot_entry: string | null;
  margin_usd: string | null;
  fees_entry: string | null;
  fees_exit: string | null;
  gross_pnl: string | null;
  net_pnl: string | null;
  peak_pnl: string | null;
  trough_pnl: string | null;
  exit_reason: string | null;
  exit_detail: string | null;
  exit_config: unknown;
  tags: Record<string, unknown> | null;
}

export interface LegRow {
  id: string;
  run_id: string;
  symbol: string;
  type: string;
  side: string;
  role: string;
  strike: string;
  expiry_ms: string;
  lots: number;
  entry_price: string;
  exit_price: string | null;
}

export async function runKeyExists(runKey: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM bot_runs WHERE run_key = $1', [runKey]);
  return (r.rowCount ?? 0) > 0;
}

export async function insertRun(row: {
  runKey: string;
  strategy: string;
  book: string;
  mode: string;
  dateKey: string;
  status: 'open' | 'skipped' | 'failed';
  entryAtMs?: number;
  plannedExitAtMs?: number;
  spotEntry?: number;
  marginUsd?: number;
  feesEntry?: number;
  exitConfig?: unknown;
  tags?: Record<string, unknown>;
}): Promise<string | null> {
  const r = await pool.query(
    `INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, entry_at, planned_exit_at, spot_entry, margin_usd, fees_entry, exit_config, tags)
     VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0), to_timestamp($8/1000.0), $9,$10,$11,$12,$13)
     ON CONFLICT (run_key) DO NOTHING RETURNING id`,
    [
      row.runKey,
      row.strategy,
      row.book,
      row.mode,
      row.dateKey,
      row.status,
      row.entryAtMs ?? null,
      row.plannedExitAtMs ?? null,
      row.spotEntry ?? null,
      row.marginUsd ?? null,
      row.feesEntry ?? 0,
      row.exitConfig ? JSON.stringify(row.exitConfig) : null,
      JSON.stringify(row.tags ?? {}),
    ],
  );
  return r.rows[0]?.id ?? null;
}

export async function insertLeg(runId: string, l: {
  symbol: string; type: string; side: string; role: string; strike: number; expiryMs: number; lots: number; entryPrice: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO bot_legs (run_id, symbol, type, side, role, strike, expiry_ms, lots, entry_price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [runId, l.symbol, l.type, l.side, l.role, l.strike, l.expiryMs, l.lots, l.entryPrice],
  );
}

export async function insertFill(runId: string, f: {
  legSymbol: string; action: 'entry' | 'exit'; side: 'buy' | 'sell'; lots: number; intendedPrice: number; avgPrice: number; filled: number; partial: boolean; fee: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO bot_fills (run_id, leg_symbol, action, side, lots, intended_price, avg_price, filled, partial, fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [runId, f.legSymbol, f.action, f.side, f.lots, f.intendedPrice, f.avgPrice, f.filled, f.partial, f.fee],
  );
}

export async function closeRun(runId: string, c: {
  exitAtMs: number; grossPnl: number; netPnl: number; feesExit: number; reason: string; detail: string;
}): Promise<void> {
  await pool.query(
    `UPDATE bot_runs SET status='closed', exit_at = to_timestamp($2/1000.0), gross_pnl=$3, net_pnl=$4, fees_exit=$5, exit_reason=$6, exit_detail=$7 WHERE id=$1`,
    [runId, c.exitAtMs, c.grossPnl, c.netPnl, c.feesExit, c.reason, c.detail],
  );
}

export async function setLegExit(runId: string, symbol: string, price: number): Promise<void> {
  await pool.query('UPDATE bot_legs SET exit_price=$3 WHERE run_id=$1 AND symbol=$2', [runId, symbol, price]);
}

export async function updatePeaks(runId: string, netPnl: number): Promise<void> {
  await pool.query(
    `UPDATE bot_runs SET peak_pnl = GREATEST(COALESCE(peak_pnl, $2), $2), trough_pnl = LEAST(COALESCE(trough_pnl, $2), $2) WHERE id=$1`,
    [runId, netPnl],
  );
}

export async function getOpenRuns(): Promise<Array<RunRow & { legs: LegRow[] }>> {
  const runs = await pool.query<RunRow>(`SELECT * FROM bot_runs WHERE status='open' ORDER BY entry_at`);
  const out: Array<RunRow & { legs: LegRow[] }> = [];
  for (const r of runs.rows) {
    const legs = await pool.query<LegRow>('SELECT * FROM bot_legs WHERE run_id=$1 ORDER BY id', [r.id]);
    out.push({ ...r, legs: legs.rows });
  }
  return out;
}

export async function upsertMark(m: {
  runId: string; minuteMs: number; netPnl: number; grossPnl: number; pctMargin: number; spot: number; snapshot: unknown;
}): Promise<void> {
  await pool.query(
    `INSERT INTO bot_minute_marks (run_id, minute_ms, net_pnl, gross_pnl, pct_margin, spot, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_id, minute_ms) DO UPDATE SET net_pnl=EXCLUDED.net_pnl, gross_pnl=EXCLUDED.gross_pnl, pct_margin=EXCLUDED.pct_margin, spot=EXCLUDED.spot, snapshot=EXCLUDED.snapshot`,
    [m.runId, m.minuteMs, m.netPnl, m.grossPnl, m.pctMargin, m.spot, JSON.stringify(m.snapshot)],
  );
}

export async function upsertContext(minuteMs: number, spot: number | null, ctx: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO bot_minute_context (minute_ms, spot, ctx) VALUES ($1,$2,$3) ON CONFLICT (minute_ms) DO UPDATE SET spot=EXCLUDED.spot, ctx=EXCLUDED.ctx`,
    [minuteMs, spot, JSON.stringify(ctx)],
  );
}

export async function logEvent(e: {
  runId?: string | null; strategy?: string; type: string; severity?: 'info' | 'warn' | 'error'; message: string; data?: unknown;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO bot_events (run_id, strategy, type, severity, message, data) VALUES ($1,$2,$3,$4,$5,$6)`,
      [e.runId ?? null, e.strategy ?? null, e.type, e.severity ?? 'info', e.message, e.data ? JSON.stringify(e.data) : null],
    );
  } catch (err) {
    console.error('[bot] event log failed', err);
  }
}

export async function getConfig(): Promise<{ paused: boolean; kill_switch: boolean }> {
  const r = await pool.query<{ paused: boolean; kill_switch: boolean }>('SELECT paused, kill_switch FROM bot_config WHERE id=1');
  return r.rows[0] ?? { paused: false, kill_switch: false };
}

export async function setConfig(patch: { paused?: boolean; killSwitch?: boolean }): Promise<void> {
  await pool.query(
    `UPDATE bot_config SET paused = COALESCE($1, paused), kill_switch = COALESCE($2, kill_switch), updated_at = now() WHERE id=1`,
    [patch.paused ?? null, patch.killSwitch ?? null],
  );
}

export async function pnlSince(sinceMs: number): Promise<number> {
  const r = await pool.query<{ s: string | null }>(
    `SELECT COALESCE(SUM(net_pnl),0) AS s FROM bot_runs WHERE status='closed' AND exit_at >= to_timestamp($1/1000.0)`,
    [sinceMs],
  );
  return Number(r.rows[0]?.s ?? 0);
}
