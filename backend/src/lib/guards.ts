import { DESK_USER_ID } from '../services/auth-store.js';

/**
 * Admin check that does not depend on a Fastify decorator, so any route file (and its test) can use it as a preHandler.
 * The owner is the seeded desk user: tokens issued before accounts existed carry its id with role "trader", so the id counts too.
 */
export async function requireAdmin(request: any, reply: any): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    return reply.status(401).send({ success: false, error: 'Unauthorized' });
  }
  const u = request.user as { sub?: string; role?: string } | undefined;
  if (!u || (u.role !== 'admin' && u.sub !== DESK_USER_ID)) {
    return reply.status(403).send({ success: false, error: 'Only the desk owner can do this' });
  }
}

/** The signed-in user's id from a verified token. */
export const userId = (request: any): string => String((request.user as { sub?: string } | undefined)?.sub ?? DESK_USER_ID);
