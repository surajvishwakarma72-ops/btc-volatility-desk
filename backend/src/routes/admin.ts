import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DESK_USER_ID } from '../services/auth-store.js';
import { isTokenRevoked } from '../services/session-guard.js';
import { ensureAdminAuditSchema, getAuditLogs, logAudit } from '../services/audit-logger.js';
import { pool } from '../db/index.js';
import { isDeskHalted, setDeskHalted, isAdminKillSwitchEnabled } from '../services/kill-switch.js';
import { broadcastKillSwitch } from './ws-desk.js';
import { broadcastKillSwitchEvent } from '../services/desk-events.js';

function parseCookies(header: string): Record<string, string> {
  const list: Record<string, string> = {};
  for (const part of header.split(';')) {
    const [rawK, ...rawV] = part.split('=');
    const k = rawK?.trim();
    if (!k) continue;
    list[k] = decodeURIComponent(rawV.join('=').trim());
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
}

async function verifyAdminAuth(request: FastifyRequest, fastify: any): Promise<{ user: DecodedUser | null; errorStatus?: number; error?: string }> {
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

  const role = decoded.role;
  const uid = decoded.sub || decoded.id;
  const isAdmin = role === 'admin' || role === 'owner' || uid === DESK_USER_ID;

  if (!isAdmin) {
    return { user: null, errorStatus: 403, error: 'Forbidden: Admin access required' };
  }

  return { user: decoded };
}

export const adminRoutes: FastifyPluginAsync = async (fastify) => {
  const handleAuditGet = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await verifyAdminAuth(request, fastify);
    if (!auth.user) {
      return reply.status(auth.errorStatus || 401).send({ success: false, error: auth.error });
    }

    await ensureAdminAuditSchema(pool);

    const query = (request.query || {}) as {
      limit?: string | number;
      offset?: string | number;
      action?: string;
      actor_id?: string;
    };

    const limit = query.limit !== undefined ? Number(query.limit) : 50;
    const offset = query.offset !== undefined ? Number(query.offset) : 0;
    const action = typeof query.action === 'string' ? query.action.trim() : undefined;
    const actorId = typeof query.actor_id === 'string' ? query.actor_id.trim() : undefined;

    const { rows, total } = await getAuditLogs(pool, { limit, offset, action, actorId });

    return reply.status(200).send({
      success: true,
      count: rows.length,
      total,
      limit,
      offset,
      audit_logs: rows,
      logs: rows,
      data: rows,
    });
  };

  // GET /api/v1/admin/kill-switch/status
  const handleKillSwitchStatus = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      halted: isDeskHalted(),
      flag_enabled: isAdminKillSwitchEnabled(),
    });
  };

  // POST /api/v1/admin/kill-switch
  const handleKillSwitchPost = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await verifyAdminAuth(request, fastify);
    if (!auth.user) {
      return reply.status(401).send({
        success: false,
        error: auth.error || 'Unauthorized: Owner session required',
      });
    }

    const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip || '127.0.0.1';
    const actorId = auth.user.sub || auth.user.id || DESK_USER_ID;

    // Feature flag gate: ENABLE_ADMIN_KILL_SWITCH must be true
    if (!isAdminKillSwitchEnabled()) {
      void logAudit(pool, actorId, 'kill_switch', 'denied', ip);
      return reply.status(403).send({
        success: false,
        error: 'Kill switch is disabled by owner setting (D5)',
        halted: isDeskHalted(),
        flag_enabled: false,
      });
    }

    const body = (request.body || {}) as { resume?: boolean; reset?: boolean; halted?: boolean };
    const isResume = body.resume === true || body.reset === true || body.halted === false;

    if (isResume) {
      setDeskHalted(false);
      broadcastKillSwitch(false);
      broadcastKillSwitchEvent(false);
      void logAudit(pool, actorId, 'kill_switch_reset', 'success', ip);
      return reply.status(200).send({
        success: true,
        halted: false,
        flag_enabled: true,
        message: 'Desk resumed successfully',
      });
    }

    // Activate kill switch: deskHalted = true
    setDeskHalted(true);
    broadcastKillSwitch(true);
    broadcastKillSwitchEvent(true);
    void logAudit(pool, actorId, 'kill_switch', 'success', ip);

    return reply.status(200).send({
      success: true,
      halted: true,
      flag_enabled: true,
      message: 'Desk halted successfully',
    });
  };

  fastify.get('/audit', handleAuditGet);
  fastify.get('/', handleAuditGet);
  fastify.get('/kill-switch/status', handleKillSwitchStatus);
  fastify.get('/kill-switch', handleKillSwitchStatus);
  fastify.post('/kill-switch', handleKillSwitchPost);
};
