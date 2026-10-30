import { pool } from '../db/index.js';

export interface IvHistoryRow {
  id: string;
  expiry_label: string;
  mark_vol: number;
  recorded_at: string;
}

export interface IvRankResponse {
  expiry_label: string;
  current_iv: number | null;
  iv_rank: number;
  sample_size: number;
}

let schemaReady: Promise<void> | null = null;

export async function ensureIvHistorySchema(db = pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS iv_history (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          expiry_label varchar(50) NOT NULL,
          mark_vol decimal NOT NULL,
          recorded_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_iv_history_expiry ON iv_history(expiry_label, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_iv_history_recorded_at ON iv_history(recorded_at DESC);
      `);
    })();
  }
  return schemaReady;
}

export function resetIvHistorySchemaCache(): void {
  schemaReady = null;
}

/**
 * Compute the IV Rank (percentile of currentIv in history array)
 * 
 * - If history length < 2, returns 0
 * - Returns 0-100: percentile of currentIv in history array
 */
export function computeIvRank(currentIv: number, history: number[]): number {
  if (!history || !Array.isArray(history) || history.length < 2) {
    return 0;
  }

  if (typeof currentIv !== 'number' || isNaN(currentIv)) {
    return 0;
  }

  const valid = history.map(Number).filter((v) => typeof v === 'number' && !isNaN(v));
  if (valid.length < 2) {
    return 0;
  }

  // Number of historical readings lower than currentIv
  const count = valid.filter((v) => v < currentIv).length;
  const percentile = (count / valid.length) * 100;
  const clamped = Math.max(0, Math.min(100, percentile));

  return Math.round(clamped * 100) / 100;
}

/**
 * Record a mark_vol snapshot for an expiry label.
 * mark_vol is stored directly as decimal (e.g. 0.165 = 16.5%), never multiplied by 100.
 */
export async function recordIvSnapshot(
  expiryLabel: string,
  markVol: number,
  db = pool
): Promise<IvHistoryRow> {
  await ensureIvHistorySchema(db);

  if (!expiryLabel || typeof expiryLabel !== 'string') {
    throw new Error('expiry_label is required');
  }

  const numVol = Number(markVol);
  if (isNaN(numVol)) {
    throw new Error('mark_vol must be a valid number');
  }

  const res = await db.query(
    `INSERT INTO iv_history (expiry_label, mark_vol, recorded_at)
     VALUES ($1, $2, now())
     RETURNING id, expiry_label, mark_vol, recorded_at`,
    [expiryLabel.trim(), numVol]
  );

  const row = res.rows[0];
  return {
    id: String(row.id),
    expiry_label: String(row.expiry_label),
    mark_vol: Number(row.mark_vol),
    recorded_at: new Date(row.recorded_at).toISOString(),
  };
}

/**
 * Retrieve the IV rank for a given expiry label.
 * Returns { expiry_label, current_iv, iv_rank, sample_size }
 */
export async function getIvRank(
  expiryLabel: string,
  db = pool,
  overrideCurrentIv?: number
): Promise<IvRankResponse> {
  await ensureIvHistorySchema(db);

  const label = expiryLabel ? expiryLabel.trim() : '';
  const res = await db.query(
    `SELECT mark_vol, recorded_at
     FROM iv_history
     WHERE expiry_label = $1
     ORDER BY recorded_at ASC`,
    [label]
  );

  if (!res.rows || res.rows.length === 0) {
    return {
      expiry_label: label,
      current_iv: overrideCurrentIv !== undefined ? Number(overrideCurrentIv) : null,
      iv_rank: 0,
      sample_size: 0,
    };
  }

  const history = res.rows.map((r: any) => Number(r.mark_vol)).filter((v: number) => !isNaN(v));
  const latestRowVol = Number(res.rows[res.rows.length - 1].mark_vol);
  const currentIv = overrideCurrentIv !== undefined ? Number(overrideCurrentIv) : latestRowVol;
  const ivRank = computeIvRank(currentIv, history);

  return {
    expiry_label: label,
    current_iv: currentIv,
    iv_rank: ivRank,
    sample_size: history.length,
  };
}
