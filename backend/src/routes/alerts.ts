import type { FastifyPluginAsync } from 'fastify';

/**
 * Alert Rules & Notification Routes Stub
 * 
 * Future Endpoints:
 * - GET    /api/v1/alerts/rules       List active alert threshold rules
 * - POST   /api/v1/alerts/rules       Create or update alert rule
 * - DELETE /api/v1/alerts/rules/:id   Remove alert rule
 * - GET    /api/v1/alerts/history     List triggered alert audit history
 * - POST   /api/v1/alerts/test        Send test notification to Telegram / ntfy
 * 
 * Notes:
 * - Replaces `localStorage['vt_alert_prefs_v1']` and `localStorage['btc_alerts_v1']`.
 * - Backend evaluates alert triggers 24x7 in background workers and dispatches pushes.
 */
export const alertRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
