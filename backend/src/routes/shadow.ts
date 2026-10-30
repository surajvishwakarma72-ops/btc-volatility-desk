import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getShadowCohorts, ensureShadowStrangleSchema } from '../services/shadow-strangle.js';
import { isTokenRevoked, sessionStillValid } from '../services/session-guard.js';
import { DESK_USER_ID } from '../services/auth-store.js';

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

  const userId = decoded.sub || decoded.id || DESK_USER_ID;
  if (!(await sessionStillValid(userId, decoded.iat))) {
    return { user: null, errorStatus: 401, error: 'Your password was changed. Sign in again.' };
  }

  return { user: decoded };
}

const querySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  limit: z.coerce.number().optional(),
});

/**
 * Shadow Strangle Engine Routes (Task T2.5)
 *
 * GET /api/v1/shadow/strangles - Returns last 24 cohorts ordered by cohort_hour DESC
 */
export const shadowRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/strangles', async (request: FastifyRequest, reply: FastifyReply) => {
    // 1. Session check
    const auth = await verifyAuth(request, fastify);
    if (!auth.user) {
      return reply.status(auth.errorStatus || 401).send({ success: false, error: auth.error });
    }

    // 2. Validate query params
    const parseRes = querySchema.safeParse(request.query);
    if (!parseRes.success) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid query parameter',
        details: parseRes.error.flatten(),
      });
    }

    const { status, limit } = parseRes.data;

    try {
      await ensureShadowStrangleSchema();
    } catch {}

    const cohorts = await getShadowCohorts({
      status,
      limit: limit ?? 24,
    });

    return reply.status(200).send({
      success: true,
      count: cohorts.length,
      cohorts,
      data: cohorts,
    });
  });
};
