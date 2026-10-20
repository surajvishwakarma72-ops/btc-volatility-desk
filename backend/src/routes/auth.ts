import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, users } from '../db/index.js';
import crypto from 'node:crypto';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';
const DESK_USER_ID = '00000000-0000-0000-0000-000000000001';

function passwordOk(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Authentication & Profile Routes
 * 
 * Endpoints:
 * - GET /api/v1/auth/me          Retrieve current authenticated user profile
 */
export const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/me', async (_request, reply) => {
    const userRes = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, DEFAULT_USER_ID))
      .limit(1);

    if (!userRes.length) {
      return reply.status(404).send({ success: false, error: 'User not found' });
    }

    return {
      success: true,
      data: userRes[0],
    };
  });

  fastify.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = (request.body || {}) as { password?: string };
    const expected = process.env.DESK_PASSWORD;
    if (!expected) return reply.status(503).send({ success: false, error: 'Login not configured on server' });
    if (!body.password || !passwordOk(body.password, expected)) {
      return reply.status(401).send({ success: false, error: 'Wrong password' });
    }
    const token = await reply.jwtSign({ sub: DESK_USER_ID, role: 'trader' }, { expiresIn: '30d' });
    return reply.send({ success: true, token });
  });
};
