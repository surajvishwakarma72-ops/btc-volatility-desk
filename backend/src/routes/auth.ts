import type { FastifyPluginAsync } from 'fastify';

/**
 * Authentication & User Management Routes Stub
 * 
 * Future Endpoints:
 * - POST /api/v1/auth/register    Register a new trader account
 * - POST /api/v1/auth/login       Authenticate and issue JWT cookie
 * - POST /api/v1/auth/logout      Revoke active session
 * - GET  /api/v1/auth/me          Retrieve current authenticated user profile
 * 
 * Notes:
 * - Architectural decision: Single-user first, multi-user ready.
 * - Authenticates against the canonical `users` table in PostgreSQL.
 */
export const authRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
