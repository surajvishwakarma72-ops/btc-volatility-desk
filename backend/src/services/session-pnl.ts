import { pool } from '../db/index.js';
import { ensureFillsSchema } from '../routes/fills.js';
import { DESK_USER_ID } from './auth-store.js';

export interface SessionPnlSummary {
  total_pnl: number;
  delta_pnl: number;
  gamma_pnl: number;
  theta_pnl: number;
  vega_pnl: number;
  other_pnl: number;
  fill_count: number;
}

export function getTodayUtcStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

function resolveNum(colVal: any, rawVal1: any, rawVal2?: any): number | null {
  if (colVal !== null && colVal !== undefined && colVal !== '') {
    const n = Number(colVal);
    if (!isNaN(n)) return n;
  }
  if (rawVal1 !== null && rawVal1 !== undefined && rawVal1 !== '') {
    const n = Number(rawVal1);
    if (!isNaN(n)) return n;
  }
  if (rawVal2 !== null && rawVal2 !== undefined && rawVal2 !== '') {
    const n = Number(rawVal2);
    if (!isNaN(n)) return n;
  }
  return null;
}

/**
 * Aggregates today's session P&L from the fills table.
 * Filter: filled_at >= today 00:00 UTC (or custom sinceUtc)
 * Returns: { total_pnl, delta_pnl, gamma_pnl, theta_pnl, vega_pnl, other_pnl, fill_count }
 */
export async function getSessionPnl(userId: string, sinceUtc?: string, account?: string): Promise<SessionPnlSummary> {
  await ensureFillsSchema();

  const filterTs = sinceUtc || getTodayUtcStart();

  // Only this user's fills. The owner also sees older rows saved without a user.
  const res = await pool.query(
    `SELECT * FROM fills
     WHERE filled_at >= $1 AND (user_id = $2 OR ($2::uuid = $3::uuid AND user_id IS NULL)) AND ($4::text IS NULL OR account_kind = $4)
     ORDER BY filled_at ASC`,
    [filterTs, userId, DESK_USER_ID, account ?? null]
  );

  const rows = res?.rows || [];

  if (rows.length === 0) {
    return {
      total_pnl: 0,
      delta_pnl: 0,
      gamma_pnl: 0,
      theta_pnl: 0,
      vega_pnl: 0,
      other_pnl: 0,
      fill_count: 0,
    };
  }

  let total_pnl = 0;
  let delta_pnl = 0;
  let gamma_pnl = 0;
  let theta_pnl = 0;
  let vega_pnl = 0;
  let other_pnl = 0;

  for (const row of rows) {
    let raw: any = row.raw;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = {};
      }
    }
    raw = raw || {};

    const d = resolveNum(row.delta_pnl, raw.delta_pnl, raw.pnl_attribution?.delta_pnl) ?? 0;
    const g = resolveNum(row.gamma_pnl, raw.gamma_pnl, raw.pnl_attribution?.gamma_pnl) ?? 0;
    const t = resolveNum(row.theta_pnl, raw.theta_pnl, raw.pnl_attribution?.theta_pnl) ?? 0;
    const v = resolveNum(row.vega_pnl, raw.vega_pnl, raw.pnl_attribution?.vega_pnl) ?? 0;
    let o = resolveNum(row.other_pnl, raw.other_pnl, raw.pnl_attribution?.other_pnl);
    let tot = resolveNum(row.total_pnl, raw.total_pnl, raw.pnl ?? raw.realized_pnl);

    if (tot === null && o === null) {
      tot = d + g + t + v;
      o = 0;
    } else if (tot === null && o !== null) {
      tot = d + g + t + v + o;
    } else if (tot !== null && o === null) {
      o = tot - (d + g + t + v);
    }

    delta_pnl += d;
    gamma_pnl += g;
    theta_pnl += t;
    vega_pnl += v;
    other_pnl += (o ?? 0);
    total_pnl += (tot ?? 0);
  }

  const norm = (val: number) => {
    if (Object.is(val, -0) || Math.abs(val) < 1e-10) return 0;
    return Number(val.toFixed(4));
  };

  return {
    total_pnl: norm(total_pnl),
    delta_pnl: norm(delta_pnl),
    gamma_pnl: norm(gamma_pnl),
    theta_pnl: norm(theta_pnl),
    vega_pnl: norm(vega_pnl),
    other_pnl: norm(other_pnl),
    fill_count: rows.length,
  };
}
