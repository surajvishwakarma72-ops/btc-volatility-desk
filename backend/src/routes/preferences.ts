import type { FastifyPluginAsync } from 'fastify';

/**
 * User Preferences & Desk Layout Routes Stub
 * 
 * Future Endpoints:
 * - GET   /api/v1/preferences         Get user UI preferences, theme, and enabled fx indicators
 * - PUT   /api/v1/preferences         Update user preferences
 * 
 * Notes:
 * - Replaces `localStorage['v132_ind']`, `v143_skin`, `pa_layer_prefs_v3`, `btc_vol_desk_prefs_v1`.
 * - Canonical storage: `user_preferences` table in PostgreSQL.
 * - Synced to client-side IndexedDB `kv_cache`.
 */
export const preferenceRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
