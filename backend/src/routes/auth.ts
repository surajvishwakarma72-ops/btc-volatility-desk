import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, users } from '../db/index.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

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
};
