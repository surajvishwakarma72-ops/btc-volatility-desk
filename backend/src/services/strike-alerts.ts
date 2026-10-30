/**
 * Strike Alert Engine Service (Task T3.1)
 *
 * Requirements:
 * 1. Watch shadow_strangles table every 60s
 * 2. If any active cohort has confidence_score >= 70, emit alert event
 * 3. Alert shape: {cohort_id, call_strike, put_strike, confidence_score, iv_rank, emitted_at}
 * 4. Store alerts in strike_alerts table
 * 5. GET /api/v1/alerts — returns last 50 alerts, newest first
 * 6. POST /api/v1/alerts/:id/ack — marks acknowledged_at = now()
 * 7. WebSocket broadcasts alert event to /ws/desk when new alert emits
 */

import { pool } from '../db/index.js';
import { broadcastStrikeAlertEvent } from './desk-events.js';
import { broadcastStrikeAlert } from '../routes/ws-desk.js';

export interface StrikeAlert {
  id?: string;
  cohort_id: string;
  call_strike: number;
  put_strike: number;
  confidence_score: number;
  iv_rank: number | null;
  emitted_at: string;
  acknowledged_at?: string | null;
}

let schemaReady: Promise<void> | null = null;

export async function ensureStrikeAlertsSchema(db = pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS strike_alerts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          cohort_id uuid,
          call_strike numeric NOT NULL,
          put_strike numeric NOT NULL,
          confidence_score numeric NOT NULL,
          iv_rank numeric,
          emitted_at timestamptz NOT NULL DEFAULT now(),
          acknowledged_at timestamptz
        );
        CREATE INDEX IF NOT EXISTS idx_strike_alerts_emitted_at ON strike_alerts(emitted_at DESC);
        CREATE INDEX IF NOT EXISTS idx_strike_alerts_cohort_id ON strike_alerts(cohort_id);
      `);
    })();
  }
  return schemaReady;
}

export function resetStrikeAlertsSchemaCache(): void {
  schemaReady = null;
}

/**
 * Format raw database row to StrikeAlert interface
 */
function formatStrikeAlertRow(row: any): StrikeAlert {
  return {
    id: row.id,
    cohort_id: row.cohort_id,
    call_strike: Number(row.call_strike),
    put_strike: Number(row.put_strike),
    confidence_score: Number(row.confidence_score),
    iv_rank: row.iv_rank !== null && row.iv_rank !== undefined ? Number(row.iv_rank) : null,
    emitted_at: row.emitted_at instanceof Date ? row.emitted_at.toISOString() : String(row.emitted_at),
    acknowledged_at: row.acknowledged_at
      ? (row.acknowledged_at instanceof Date ? row.acknowledged_at.toISOString() : String(row.acknowledged_at))
      : null,
  };
}

/**
 * Checks shadow_strangles for active cohorts with confidence_score >= 70
 * and emits alerts for any that haven't been alerted yet.
 */
export async function checkAndEmitStrikeAlerts(db = pool): Promise<StrikeAlert[]> {
  await ensureStrikeAlertsSchema(db);

  // Find active cohorts with confidence_score >= 70
  const cohortsRes = await db.query(`
    SELECT * FROM shadow_strangles
    WHERE status IN ('open', 'active')
      AND confidence_score >= 70
    ORDER BY cohort_hour DESC
  `);

  const emittedAlerts: StrikeAlert[] = [];

  for (const cohort of cohortsRes.rows) {
    // Deduplication check: check if alert already exists for this cohort
    const existing = await db.query(
      `SELECT id FROM strike_alerts WHERE cohort_id = $1`,
      [cohort.id]
    );

    if (existing.rows.length > 0) {
      continue;
    }

    let ivRank: number | null = null;
    if (cohort.raw) {
      const rawObj = typeof cohort.raw === 'string' ? JSON.parse(cohort.raw) : cohort.raw;
      if (rawObj && typeof rawObj.iv_rank === 'number') {
        ivRank = rawObj.iv_rank;
      }
    }
    if (ivRank === null && cohort.call_entry_iv !== undefined && cohort.put_entry_iv !== undefined) {
      ivRank = Number(((Number(cohort.call_entry_iv) + Number(cohort.put_entry_iv)) / 2).toFixed(4));
    }

    const insertRes = await db.query(
      `INSERT INTO strike_alerts (
        cohort_id, call_strike, put_strike, confidence_score, iv_rank, emitted_at
      ) VALUES ($1, $2, $3, $4, $5, now())
      RETURNING *`,
      [
        cohort.id,
        cohort.call_strike,
        cohort.put_strike,
        cohort.confidence_score,
        ivRank,
      ]
    );

    const alert = formatStrikeAlertRow(insertRes.rows[0]);

    // WebSocket and event broadcast
    broadcastStrikeAlert(alert as any);
    broadcastStrikeAlertEvent(alert as any);

    emittedAlerts.push(alert);
  }

  return emittedAlerts;
}

/**
 * Directly emit a strike alert and store it in strike_alerts.
 */
export async function emitStrikeAlert(
  input: {
    cohort_id: string;
    call_strike: number;
    put_strike: number;
    confidence_score: number;
    iv_rank?: number | null;
  },
  db = pool
): Promise<StrikeAlert> {
  await ensureStrikeAlertsSchema(db);

  const insertRes = await db.query(
    `INSERT INTO strike_alerts (
      cohort_id, call_strike, put_strike, confidence_score, iv_rank, emitted_at
    ) VALUES ($1, $2, $3, $4, $5, now())
    RETURNING *`,
    [
      input.cohort_id,
      input.call_strike,
      input.put_strike,
      input.confidence_score,
      input.iv_rank ?? null,
    ]
  );

  const alert = formatStrikeAlertRow(insertRes.rows[0]);

  broadcastStrikeAlert(alert as any);
  broadcastStrikeAlertEvent(alert as any);

  return alert;
}

/**
 * Returns last N alerts, newest first (default 50).
 */
export async function getStrikeAlerts(limit = 50, db = pool): Promise<StrikeAlert[]> {
  await ensureStrikeAlertsSchema(db);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const res = await db.query(
    `SELECT * FROM strike_alerts ORDER BY emitted_at DESC LIMIT $1`,
    [safeLimit]
  );
  return res.rows.map(formatStrikeAlertRow);
}

/**
 * Acknowledge an alert: marks acknowledged_at = now()
 */
export async function acknowledgeStrikeAlert(id: string, db = pool): Promise<StrikeAlert | null> {
  await ensureStrikeAlertsSchema(db);
  const res = await db.query(
    `UPDATE strike_alerts SET acknowledged_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  if (res.rows.length === 0) return null;
  return formatStrikeAlertRow(res.rows[0]);
}

let watcherTimer: NodeJS.Timeout | null = null;

/**
 * Start the strike alert background watcher running every intervalMs (default 60s).
 */
export function startStrikeAlertWatcher(intervalMs = 60000, db = pool): NodeJS.Timeout {
  if (watcherTimer) clearInterval(watcherTimer);
  watcherTimer = setInterval(async () => {
    try {
      await checkAndEmitStrikeAlerts(db);
    } catch (err) {
      console.error('[StrikeAlertWatcher] Error checking strike alerts:', err);
    }
  }, intervalMs);
  return watcherTimer;
}

/**
 * Stop the strike alert background watcher.
 */
export function stopStrikeAlertWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}
