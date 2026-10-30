import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/index.js';
import { isTokenRevoked, sessionStillValid } from '../services/session-guard.js';
import { DESK_USER_ID } from '../services/auth-store.js';
import { broadcastFill } from '../services/desk-events.js';
import { logAudit } from '../services/audit-logger.js';
import { isDeskHalted } from '../services/kill-switch.js';

let schemaReady: Promise<void> | null = null;

export async function ensureFillsSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS fills (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          exchange_fill_id text NOT NULL,
          account_kind varchar(10) NOT NULL,
          user_id uuid REFERENCES users(id),
          instrument varchar(10) NOT NULL,
          symbol text NOT NULL,
          side varchar(4) NOT NULL,
          qty numeric NOT NULL,
          price numeric NOT NULL,
          fee numeric NOT NULL DEFAULT 0,
          fee_tax numeric NOT NULL DEFAULT 0,
          liquidity varchar(10),
          bot_run_id uuid,
          filled_at timestamptz NOT NULL,
          raw jsonb,
          UNIQUE (account_kind, exchange_fill_id)
        );
        CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills(filled_at DESC);
        CREATE INDEX IF NOT EXISTS idx_fills_symbol ON fills(symbol);
      `);
    })();
  }
  return schemaReady;
}

export function resetFillsSchemaCache(): void {
  schemaReady = null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const list: Record<string, string> = {};
  if (!header) return list;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) list[k] = decodeURIComponent(v.join('='));
  }
  return list;
}

function getSessionToken(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    const token = cookies.desk_token || cookies.session_token || cookies.token;
    if (token) return token;
  }
  const authHeader = request.headers.authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

interface DecodedUser {
  sub?: string;
  id?: string;
  role?: string;
  email?: string;
  iat?: number;
}

async function verifyAuth(request: FastifyRequest, fastify: any): Promise<{ user: DecodedUser | null; errorStatus?: number; error?: string }> {
  if (request.query && typeof request.query === 'object' && ('token' in request.query || 'jwt' in request.query || 'authorization' in request.query)) {
    return { user: null, errorStatus: 401, error: 'Unauthorized: Query string tokens not accepted' };
  }

  const token = getSessionToken(request);
  if (!token) {
    return { user: null, errorStatus: 401, error: 'Unauthorized: Session required' };
  }

  if (isTokenRevoked(token)) {
    return { user: null, errorStatus: 401, error: 'Session invalidated. Please log in again.' };
  }

  let decoded: DecodedUser | null = null;
  try {
    decoded = fastify.jwt.verify(token);
  } catch {
    return { user: null, errorStatus: 401, error: 'Invalid session token' };
  }

  if (!decoded) {
    return { user: null, errorStatus: 401, error: 'Unauthorized' };
  }

  const uid = decoded.sub || decoded.id;
  if (!(await sessionStillValid(uid, decoded.iat))) {
    return { user: null, errorStatus: 401, error: 'Session invalidated' };
  }

  return { user: decoded };
}

function isOwner(user: DecodedUser | null): boolean {
  if (!user) return false;
  return user.role === 'owner' || user.role === 'admin' || user.sub === DESK_USER_ID;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fillItemSchema = z.object({
  exchange_fill_id: z.string().min(1, 'exchange_fill_id is required'),
  account_kind: z.enum(['main', 'sub'], {
    errorMap: () => ({ message: "account_kind must be 'main' or 'sub'" }),
  }),
  user_id: z.string().optional().nullable(),
  instrument: z.string().min(1, 'instrument is required'),
  symbol: z.string().min(1, 'symbol is required'),
  side: z.enum(['buy', 'sell'], {
    errorMap: () => ({ message: "side must be 'buy' or 'sell'" }),
  }),
  qty: z.coerce.number().positive('qty must be positive'),
  price: z.coerce.number().positive('price must be positive'),
  fee: z.coerce.number().default(0),
  fee_tax: z.coerce.number().default(0),
  liquidity: z.string().optional().nullable(),
  bot_run_id: z.string().optional().nullable(),
  filled_at: z.string().datetime({ offset: true }).or(z.string().min(1)),
  raw: z.any().optional().nullable(),
});

/**
 * Fills & P&L Source of Truth Routes (Task T2.1)
 *
 * GET  /api/v1/fills        - List historical exchange fills with filtering
 * POST /api/v1/fills/ingest - Bulk ingest / upsert fills (owner only)
 */
export const fillsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/fills
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await verifyAuth(request, fastify);
    if (!auth.user) {
      return reply.status(auth.errorStatus || 401).send({ success: false, error: auth.error });
    }

    await ensureFillsSchema();

    const query = (request.query || {}) as {
      symbol?: string;
      account_kind?: string;
      from_ts?: string;
      to_ts?: string;
      limit?: string | number;
    };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.symbol && typeof query.symbol === 'string' && query.symbol.trim()) {
      params.push(query.symbol.trim());
      conditions.push(`symbol = $${params.length}`);
    }

    if (query.account_kind && typeof query.account_kind === 'string' && query.account_kind.trim()) {
      params.push(query.account_kind.trim());
      conditions.push(`account_kind = $${params.length}`);
    }

    if (query.from_ts && typeof query.from_ts === 'string' && query.from_ts.trim()) {
      params.push(query.from_ts.trim());
      conditions.push(`filled_at >= $${params.length}`);
    }

    if (query.to_ts && typeof query.to_ts === 'string' && query.to_ts.trim()) {
      params.push(query.to_ts.trim());
      conditions.push(`filled_at <= $${params.length}`);
    }

    let limitNum = 100;
    if (query.limit !== undefined) {
      const parsedLimit = Number(query.limit);
      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        limitNum = Math.min(Math.max(parsedLimit, 1), 500);
      }
    }

    params.push(limitNum);
    const limitPlaceholder = `$${params.length}`;

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT id, exchange_fill_id, account_kind, user_id, instrument, symbol, side,
             qty, price, fee, fee_tax, liquidity, bot_run_id, filled_at, raw
      FROM fills
      ${whereClause}
      ORDER BY filled_at DESC
      LIMIT ${limitPlaceholder}
    `;

    const res = await pool.query(sql, params);
    return reply.status(200).send({
      success: true,
      count: res.rows.length,
      fills: res.rows,
      data: res.rows,
    });
  });

  // POST /api/v1/fills/ingest
  fastify.post('/ingest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isDeskHalted()) {
      return reply.status(503).send({ error: 'desk_halted' });
    }

    const auth = await verifyAuth(request, fastify);
    if (!auth.user) {
      return reply.status(auth.errorStatus || 401).send({ success: false, error: auth.error });
    }

    const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip || '127.0.0.1';
    const actorId = auth.user.sub && UUID_REGEX.test(auth.user.sub) ? auth.user.sub : DESK_USER_ID;

    if (!isOwner(auth.user)) {
      void logAudit(pool, actorId, 'fills_ingest', 'denied', ip);
      return reply.status(403).send({ success: false, error: 'Forbidden: Owner role required' });
    }

    await ensureFillsSchema();

    const rawBody = request.body;
    let itemsToProcess: unknown[] = [];
    if (Array.isArray(rawBody)) {
      itemsToProcess = rawBody;
    } else if (rawBody && typeof rawBody === 'object' && Array.isArray((rawBody as any).fills)) {
      itemsToProcess = (rawBody as any).fills;
    } else if (rawBody && typeof rawBody === 'object') {
      itemsToProcess = [rawBody];
    }

    let inserted = 0;
    let skipped = 0;

    for (const rawItem of itemsToProcess) {
      const parsed = fillItemSchema.safeParse(rawItem);
      if (!parsed.success) {
        skipped++;
        continue;
      }

      const item = parsed.data;
      const uid = item.user_id && UUID_REGEX.test(item.user_id)
        ? item.user_id
        : (auth.user.sub && UUID_REGEX.test(auth.user.sub) ? auth.user.sub : null);
      const botRunId = item.bot_run_id && UUID_REGEX.test(item.bot_run_id) ? item.bot_run_id : null;
      const rawJson = item.raw !== undefined ? JSON.stringify(item.raw) : null;

      const insertRes = await pool.query(
        `INSERT INTO fills (
           exchange_fill_id, account_kind, user_id, instrument, symbol, side,
           qty, price, fee, fee_tax, liquidity, bot_run_id, filled_at, raw
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
         )
         ON CONFLICT (account_kind, exchange_fill_id) DO NOTHING
         RETURNING *`,
        [
          item.exchange_fill_id,
          item.account_kind,
          uid,
          item.instrument,
          item.symbol,
          item.side,
          item.qty,
          item.price,
          item.fee,
          item.fee_tax,
          item.liquidity || null,
          botRunId,
          item.filled_at,
          rawJson,
        ]
      );

      if (insertRes.rows.length > 0) {
        inserted++;
        broadcastFill(insertRes.rows[0]);
      } else {
        skipped++;
      }
    }

    void logAudit(pool, actorId, 'fills_ingest', 'success', ip);
    return reply.status(200).send({
      success: true,
      inserted,
      skipped,
    });
  });
};

