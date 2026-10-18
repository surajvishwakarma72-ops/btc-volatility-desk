import type { FastifyPluginAsync } from 'fastify';

/**
 * Delta Exchange India Authenticated Gateway Stub
 * 
 * Future Endpoints:
 * - GET  /api/v1/delta/positions      Fetch open options positions directly from Delta
 * - GET  /api/v1/delta/orders         Fetch recent orders and fills
 * - POST /api/v1/delta/credentials    Save encrypted API Key and Secret (AES-256-GCM)
 * - GET  /api/v1/delta/status         Verify connection status and IP whitelist health
 * 
 * Notes:
 * - Replaces client-side HMAC signing and the Vercel proxy (`vega-vault.vercel.app`).
 * - All requests are signed server-side in memory using encrypted credentials.
 * - Outgoing requests originate from the server's static IP.
 */
export const deltaRoutes: FastifyPluginAsync = async (_fastify) => {
  // Empty stub - no business logic implemented yet
};
