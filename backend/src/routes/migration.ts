import type { FastifyPluginAsync } from 'fastify';

/**
 * Browser Data Migration Routes — DEFERRED to Phase D.
 *
 * NOT YET IMPLEMENTED. The one-time localStorage/IndexedDB → PostgreSQL import
 * (spec in MIGRATION.md: `v99_trades`, `v147_nights`, `btc_drawings_v1`, etc.) is
 * scheduled for the canonical-persistence phase (Phase D). This stub intentionally
 * registers no endpoints; it exists only to keep the route plugin wiring stable.
 */
export const migrationRoutes: FastifyPluginAsync = async (_fastify) => {
  // Intentionally empty — see Phase D (canonical persistence).
};
