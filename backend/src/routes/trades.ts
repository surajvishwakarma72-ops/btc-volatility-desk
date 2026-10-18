import type { FastifyPluginAsync } from 'fastify';

/**
 * Trades & Strangle Execution Routes Stub
 * 
 * Future Endpoints:
 * - GET    /api/v1/trades             List historical and active strangle trades
 * - GET    /api/v1/trades/active      Get the currently open strangle (replaces v99_trade)
 * - POST   /api/v1/trades             Record new trade entry (strikes, premium, IV, Greeks)
 * - PATCH  /api/v1/trades/:id         Update trade state or close position (record exit IV, P&L)
 * - DELETE /api/v1/trades/:id         Remove or archive trade record
 * 
 * Notes:
 * - Canonical storage: `trades` table in PostgreSQL.
 * - Synced to client-side IndexedDB `trades_cache` for instant offline rendering.
 */
export const tradeRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
