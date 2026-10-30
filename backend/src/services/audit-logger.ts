import { pool } from '../db/index.js';

export interface AuditLogRow {
  id: string;
  ts: string;
  actor_id: string;
  action: string;
  result: string;
  ip?: string | null;
}

export interface GetAuditLogsOptions {
  limit?: number;
  offset?: number;
  actorId?: string;
  action?: string;
}

let schemaReady: Promise<void> | null = null;

export async function ensureAdminAuditSchema(dbClient: any = pool): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      try {
        const client = dbClient || pool;
        await client.query(`
          CREATE TABLE IF NOT EXISTS desk_admin_audit (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            ts timestamptz NOT NULL DEFAULT now(),
            actor_id uuid NOT NULL REFERENCES users(id),
            action varchar(40) NOT NULL,
            result varchar(20) NOT NULL,
            ip inet
          );
          CREATE INDEX IF NOT EXISTS idx_audit_ts ON desk_admin_audit(ts DESC);
          CREATE INDEX IF NOT EXISTS idx_audit_actor ON desk_admin_audit(actor_id);
        `);
      } catch (err) {
        schemaReady = null;
        console.error('[audit-logger] Failed to ensure admin audit schema:', err);
      }
    })();
  }
  return schemaReady;
}

/**
 * Log an administrative, security, or data modification action.
 *
 * Rules:
 * - Inserts a row into desk_admin_audit.
 * - NEVER throws: wrapped in try/catch, logs error to console.error if insert fails.
 * - action truncated to max 40 chars.
 * - result truncated to max 20 chars.
 */
export async function logAudit(
  dbClient: any,
  actorId: string,
  action: string,
  result: string,
  ip?: string | null,
): Promise<void> {
  try {
    const client = dbClient || pool;
    if (!client || typeof client.query !== 'function') {
      console.error('[audit-logger] Invalid database client provided to logAudit');
      return;
    }

    await ensureAdminAuditSchema(client);

    const truncatedAction = typeof action === 'string' ? action.slice(0, 40) : '';
    const truncatedResult = typeof result === 'string' ? result.slice(0, 20) : '';

    let cleanIp: string | null = null;
    if (ip && typeof ip === 'string') {
      const first = ip.split(',')[0]?.trim();
      if (first && first !== 'unknown' && first !== 'undefined') {
        cleanIp = first;
      }
    }

    await client.query(
      `INSERT INTO desk_admin_audit (actor_id, action, result, ip)
       VALUES ($1, $2, $3, $4)`,
      [actorId, truncatedAction, truncatedResult, cleanIp],
    );
  } catch (err) {
    console.error('[audit-logger] Failed to insert audit log:', err);
  }
}

/**
 * Fetch historical audit log rows ordered by most recent first.
 */
export async function getAuditLogs(
  dbClient: any = pool,
  options: GetAuditLogsOptions = {},
): Promise<{ rows: AuditLogRow[]; total: number }> {
  const client = dbClient || pool;
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
  const offset = Math.max(Number(options.offset) || 0, 0);

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.actorId) {
    params.push(options.actorId);
    conditions.push(`actor_id = $${params.length}`);
  }

  if (options.action) {
    params.push(options.action);
    conditions.push(`action = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await client.query(`SELECT count(*)::int as total FROM desk_admin_audit ${whereClause}`, params);
  const total = countRes.rows?.[0]?.total ?? 0;

  params.push(limit);
  const limitPlaceholder = `$${params.length}`;
  params.push(offset);
  const offsetPlaceholder = `$${params.length}`;

  const querySql = `
    SELECT id, ts, actor_id, action, result, ip::text
    FROM desk_admin_audit
    ${whereClause}
    ORDER BY ts DESC
    LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
  `;

  const res = await client.query(querySql, params);
  return { rows: res.rows || [], total };
}
