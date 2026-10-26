import { randomUUID } from 'node:crypto';
import { pool } from '../../db/index.js';
import { strategySchema, type AlgoStrategy } from '../../lib/algo/rule.js';
import { ensureAuthSchema } from '../auth-store.js';

/**
 * Storage for the Algo panel: the rules a user wrote, one run per strategy per entry window, the saved defaults behind the
 * Ask-me "entry 50" command, and the one pending Ask-me order that is waiting for its "ok".
 */
const DDL = `
CREATE TABLE IF NOT EXISTS algo_strategies (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  rule jsonb NOT NULL,
  lots integer NOT NULL DEFAULT 1,
  armed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS algo_strategies_user_idx ON algo_strategies (user_id);
CREATE TABLE IF NOT EXISTS algo_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  strategy_id uuid,
  name text NOT NULL,
  date_key text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  lots integer NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  plan jsonb,
  ref text,
  window_start timestamptz,
  entered_at timestamptz,
  exit_at timestamptz,
  exited_at timestamptz,
  exit_reason text,
  net_pnl numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS algo_runs_user_idx ON algo_runs (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS algo_runs_window_idx ON algo_runs (strategy_id, date_key) WHERE strategy_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS algo_run_marks (
  run_id uuid NOT NULL,
  t timestamptz NOT NULL,
  net numeric NOT NULL,
  spot numeric,
  PRIMARY KEY (run_id, t)
);
CREATE TABLE IF NOT EXISTS algo_defaults (
  user_id uuid PRIMARY KEY,
  rule jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS algo_pending (
  user_id uuid PRIMARY KEY,
  data jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
`;

let ready: Promise<void> | null = null;
export function ensureAlgoSchema(): Promise<void> {
  if (!ready) {
    ready = ensureAuthSchema().then(() => pool.query(DDL)).then(() => undefined);
    ready.catch(() => { ready = null; });
  }
  return ready;
}

export interface StrategyRow {
  id: string;
  userId: string;
  rule: AlgoStrategy;
  lots: number;
  armed: boolean;
  updatedAt: number;
}

const mapStrategy = (r: any): StrategyRow | null => {
  const p = strategySchema.safeParse(r.rule);
  // a stored rule that no longer validates is left out rather than traded
  return p.success ? { id: r.id, userId: r.user_id, rule: p.data, lots: Number(r.lots), armed: !!r.armed, updatedAt: new Date(r.updated_at).getTime() } : null;
};

export async function listStrategies(userId: string): Promise<StrategyRow[]> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT * FROM algo_strategies WHERE user_id = $1 ORDER BY created_at', [userId]);
  return (r.rows as any[]).map(mapStrategy).filter((x): x is StrategyRow => x != null);
}

export async function listArmed(): Promise<StrategyRow[]> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT * FROM algo_strategies WHERE armed = true');
  return (r.rows as any[]).map(mapStrategy).filter((x): x is StrategyRow => x != null);
}

export async function getStrategy(userId: string, id: string): Promise<StrategyRow | null> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT * FROM algo_strategies WHERE user_id = $1 AND id = $2', [userId, id]);
  return r.rows[0] ? mapStrategy(r.rows[0]) : null;
}

/** Save a rule. Editing a strategy always disarms it, so a changed rule is never traded before the user re-arms it. */
export async function saveStrategy(userId: string, id: string | null, rule: AlgoStrategy, lots: number): Promise<StrategyRow> {
  await ensureAlgoSchema();
  const sid = id ?? randomUUID();
  await pool.query(
    `INSERT INTO algo_strategies (id, user_id, rule, lots, armed) VALUES ($1,$2,$3,$4,false)
     ON CONFLICT (id) DO UPDATE SET rule = $3, lots = $4, armed = false, updated_at = now() WHERE algo_strategies.user_id = $2`,
    [sid, userId, JSON.stringify(rule), lots],
  );
  return (await getStrategy(userId, sid))!;
}

export async function setArmed(userId: string, id: string, armed: boolean): Promise<boolean> {
  await ensureAlgoSchema();
  return ((await pool.query('UPDATE algo_strategies SET armed = $3, updated_at = now() WHERE user_id = $1 AND id = $2', [userId, id, armed])).rowCount ?? 0) > 0;
}

export async function deleteStrategy(userId: string, id: string): Promise<boolean> {
  await ensureAlgoSchema();
  return ((await pool.query('DELETE FROM algo_strategies WHERE user_id = $1 AND id = $2', [userId, id])).rowCount ?? 0) > 0;
}

// ---------- runs ----------

export type RunStatus = 'entered' | 'exited' | 'skipped' | 'failed' | 'dry';

export interface RunRow {
  id: string;
  userId: string;
  strategyId: string | null;
  name: string;
  dateKey: string;
  mode: 'paper' | 'live';
  status: RunStatus;
  lots: number;
  reason: string;
  plan: any;
  ref: string | null;
  windowStart: number | null;
  enteredAt: number | null;
  exitAt: number | null;
  exitedAt: number | null;
  exitReason: string | null;
  netPnl: number | null;
}

const ms = (v: unknown) => (v == null ? null : new Date(v as string).getTime());
const mapRun = (r: any): RunRow => ({
  id: r.id, userId: r.user_id, strategyId: r.strategy_id ?? null, name: r.name, dateKey: r.date_key, mode: r.mode, status: r.status, lots: Number(r.lots),
  reason: r.reason, plan: r.plan ?? null, ref: r.ref ?? null, windowStart: ms(r.window_start), enteredAt: ms(r.entered_at), exitAt: ms(r.exit_at),
  exitedAt: ms(r.exited_at), exitReason: r.exit_reason ?? null, netPnl: r.net_pnl == null ? null : Number(r.net_pnl),
});

/** Create the run for one entry window. Returns null when this strategy already has a run for that day (the unique index). */
export async function createRun(run: Omit<RunRow, 'id' | 'exitedAt' | 'exitReason' | 'netPnl'> & { id?: string }): Promise<RunRow | null> {
  await ensureAlgoSchema();
  const id = run.id ?? randomUUID();
  const r = await pool.query(
    `INSERT INTO algo_runs (id, user_id, strategy_id, name, date_key, mode, status, lots, reason, plan, ref, window_start, entered_at, exit_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, to_timestamp($12::double precision/1000.0), to_timestamp($13::double precision/1000.0), to_timestamp($14::double precision/1000.0))
     ON CONFLICT DO NOTHING RETURNING *`,
    [id, run.userId, run.strategyId, run.name, run.dateKey, run.mode, run.status, run.lots, run.reason, run.plan == null ? null : JSON.stringify(run.plan), run.ref, run.windowStart, run.enteredAt, run.exitAt],
  );
  return r.rows[0] ? mapRun(r.rows[0]) : null;
}

export async function finishRun(id: string, status: RunStatus, exitReason: string, netPnl: number | null): Promise<void> {
  await ensureAlgoSchema();
  await pool.query('UPDATE algo_runs SET status = $2, exit_reason = $3, net_pnl = $4, exited_at = now() WHERE id = $1', [id, status, exitReason, netPnl]);
}

export async function getRun(strategyId: string, dateKey: string): Promise<RunRow | null> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT * FROM algo_runs WHERE strategy_id = $1 AND date_key = $2', [strategyId, dateKey]);
  return r.rows[0] ? mapRun(r.rows[0]) : null;
}

export async function getRunById(userId: string, id: string): Promise<RunRow | null> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT * FROM algo_runs WHERE user_id = $1 AND id = $2', [userId, id]);
  return r.rows[0] ? mapRun(r.rows[0]) : null;
}

export async function openRuns(): Promise<RunRow[]> {
  await ensureAlgoSchema();
  return ((await pool.query(`SELECT * FROM algo_runs WHERE status = 'entered'`)).rows as any[]).map(mapRun);
}

export async function recentRuns(userId: string, limit = 30): Promise<RunRow[]> {
  await ensureAlgoSchema();
  return ((await pool.query('SELECT * FROM algo_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit])).rows as any[]).map(mapRun);
}

// ---------- PnL by minute ----------

/** One net-PnL sample per minute per run; a second sample in the same minute is ignored. */
export async function recordMark(runId: string, tMs: number, net: number, spot: number | null): Promise<void> {
  await ensureAlgoSchema();
  const minute = Math.floor(tMs / 60_000) * 60_000;
  await pool.query(
    'INSERT INTO algo_run_marks (run_id, t, net, spot) VALUES ($1, to_timestamp($2::double precision / 1000.0), $3, $4) ON CONFLICT DO NOTHING',
    [runId, minute, net, spot],
  );
}

export interface MarkSeries { t: number[]; net: number[]; spot: Array<number | null> }

export async function getMarks(runId: string): Promise<MarkSeries> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT t, net, spot FROM algo_run_marks WHERE run_id = $1 ORDER BY t', [runId]);
  const rows = r.rows as any[];
  return { t: rows.map((x) => new Date(x.t).getTime()), net: rows.map((x) => Number(x.net)), spot: rows.map((x) => (x.spot == null ? null : Number(x.spot))) };
}

// ---------- defaults and the pending Ask-me order ----------

export async function getDefaults(userId: string): Promise<AlgoStrategy | null> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT rule FROM algo_defaults WHERE user_id = $1', [userId]);
  const p = r.rows[0] ? strategySchema.safeParse(r.rows[0].rule) : null;
  return p?.success ? p.data : null;
}

export async function saveDefaults(userId: string, rule: AlgoStrategy): Promise<void> {
  await ensureAlgoSchema();
  await pool.query(
    `INSERT INTO algo_defaults (user_id, rule) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET rule = $2, updated_at = now()`,
    [userId, JSON.stringify(rule)],
  );
}

export interface PendingOrder {
  stage: 'summary' | 'builder' | 'exit';
  rule: AlgoStrategy;
  lots: number;
}

const PENDING_MS = 10 * 60_000;

export async function setPending(userId: string, data: PendingOrder): Promise<void> {
  await ensureAlgoSchema();
  await pool.query(
    `INSERT INTO algo_pending (user_id, data, expires_at) VALUES ($1,$2, now() + ($3 || ' milliseconds')::interval)
     ON CONFLICT (user_id) DO UPDATE SET data = $2, expires_at = now() + ($3 || ' milliseconds')::interval`,
    [userId, JSON.stringify(data), String(PENDING_MS)],
  );
}

export async function getPending(userId: string): Promise<PendingOrder | null> {
  await ensureAlgoSchema();
  const r = await pool.query('SELECT data FROM algo_pending WHERE user_id = $1 AND expires_at > now()', [userId]);
  if (!r.rows[0]) return null;
  const d = r.rows[0].data as PendingOrder;
  const p = strategySchema.safeParse(d.rule);
  return p.success ? { stage: d.stage, rule: p.data, lots: Number(d.lots) } : null;
}

export async function clearPending(userId: string): Promise<void> {
  await ensureAlgoSchema();
  await pool.query('DELETE FROM algo_pending WHERE user_id = $1', [userId]);
}
