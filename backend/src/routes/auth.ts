import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, users } from '../db/index.js';
import crypto from 'node:crypto';

const DESK_USER_ID = '00000000-0000-0000-0000-000000000001';

function passwordOk(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  // Length check first avoids a timingSafeEqual throw; it leaks only the password length, which is
  // an acceptable trade-off for a single-user desk behind HTTPS + a 10/min login rate limit.
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
      .where(eq(users.id, DESK_USER_ID))
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
    const raw = (request.body || {}) as Record<string, unknown>;
    const password = typeof raw.password === 'string' ? raw.password : null; // reject non-string bodies (avoids Buffer.from throw -> 500)
    const expected = process.env.DESK_PASSWORD;
    if (!expected) return reply.status(503).send({ success: false, error: 'Login not configured on server' });
    if (!password || !passwordOk(password, expected)) {
      return reply.status(401).send({ success: false, error: 'Wrong password' });
    }
    const token = await reply.jwtSign({ sub: DESK_USER_ID, role: 'trader' }, { expiresIn: '30d' });
    return reply.send({ success: true, token });
  });
};
