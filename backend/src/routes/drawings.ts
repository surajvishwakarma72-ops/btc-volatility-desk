import type { FastifyPluginAsync } from 'fastify';

/**
 * Chart Drawings & Annotations Routes Stub
 * 
 * Future Endpoints:
 * - GET    /api/v1/drawings           Retrieve all saved user drawings for symbol (default BTCUSDT)
 * - POST   /api/v1/drawings           Persist a new drawing (horizontal ray, trendline, level)
 * - PUT    /api/v1/drawings/:id       Update drawing coordinates or style
 * - DELETE /api/v1/drawings/:id       Delete drawing
 * 
 * Notes:
 * - Replaces `localStorage['btc_drawings_v1']`.
 * - Canonical storage: `chart_drawings` table in PostgreSQL.
 * - Synced with client-side IndexedDB `drawings_cache` for instant canvas repaint.
 */
export const drawingRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
