import type { FastifyPluginAsync } from 'fastify';

/**
 * Browser Data Migration Routes Stub
 * 
 * Future Endpoints:
 * - POST /api/v1/migration/import     Ingest JSON bundle exported from legacy browser storage
 * - GET  /api/v1/migration/status     Get status of past migration imports
 * 
 * Notes:
 * - One-time migration pipeline defined in MIGRATION.md.
 * - Ingests localStorage (`v99_trades`, `v147_nights`, `btc_drawings_v1`) and IndexedDB data into PostgreSQL.
 */
export const migrationRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
