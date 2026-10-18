import type { FastifyPluginAsync } from 'fastify';

/**
 * Nightly Reviews & Calendar History Routes Stub
 * 
 * Future Endpoints:
 * - GET  /api/v1/nights               List all past session night reviews (249+ tested nights)
 * - GET  /api/v1/nights/:date         Get specific night review facts, metrics, and exit hour
 * - POST /api/v1/nights               Record completed night outcome (replaces localStorage v147_nights)
 * - GET  /api/v1/nights/stats         Aggregate stats: win rates per weekday, exit hour distribution
 * 
 * Notes:
 * - Replaces `localStorage['v147_nights']` and `localStorage['ivcool:nights']`.
 * - Canonical storage: `nightly_reviews` table in PostgreSQL.
 */
export const nightRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
