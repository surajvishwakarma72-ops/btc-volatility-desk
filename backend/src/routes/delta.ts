import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';

/**
 * Delta Exchange India Authenticated Gateway
 *
 * Provides:
 * - GET /api/v1/delta/signed   Server-side HMAC-signed relay (key+secret from env, never the browser)
 * - GET /api/v1/delta/ip       Retrieve the server's public outbound IP for easy whitelisting on Delta
 * - GET /api/v1/delta/status   Verify gateway health and reachability to Delta
 */

const DELTA_BASE = 'https://api.india.delta.exchange';

/**
 * Sign a Delta Exchange API request using the server-held secret.
 * message = method + timestamp + path + queryString
 * queryString is the '?'-prefixed query string, or empty string.
 */
export function signDelta(secret: string, method: string, ts: string, path: string, query: string): string {
  return crypto.createHmac('sha256', secret).update(method + ts + path + query).digest('hex');
}

let cachedServerIp: string | null = null;
let lastIpCheck = 0;

/**
 * Fetch and cache the server's public outbound IPv4 address
 */
export async function getServerOutboundIp(): Promise<string | null> {
  const now = Date.now();
  if (cachedServerIp && now - lastIpCheck < 5 * 60 * 1000) {
    return cachedServerIp;
  }

  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const json = await res.json() as { ip?: string };
      if (json && json.ip) {
        cachedServerIp = json.ip;
        lastIpCheck = now;
        return cachedServerIp;
      }
    }
  } catch {
    // Fallback to secondary IP discovery
    try {
      const res = await fetch('https://api64.ipify.org?format=json', {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const json = await res.json() as { ip?: string };
        if (json && json.ip) {
          cachedServerIp = json.ip;
          lastIpCheck = now;
          return cachedServerIp;
        }
      }
    } catch {
      // Ignore fallback failure
    }
  }

  return cachedServerIp;
}

export const deltaRoutes: FastifyPluginAsync = async (fastify) => {
  // Return server public IP for whitelisting on Delta
  fastify.get('/ip', async (_request, reply) => {
    const ip = await getServerOutboundIp();
    return reply.send({
      success: true,
      serverIp: ip,
      note: 'Add this IP to your Delta Exchange India API key whitelist.',
    });
  });

  // Health and connectivity check to Delta API
  fastify.get('/status', async (_request, reply) => {
    const ip = await getServerOutboundIp();
    try {
      const start = Date.now();
      // /v2/settings is a lightweight public endpoint (Delta India has no /v2/time — that 404s).
      const res = await fetch(`${DELTA_BASE}/v2/settings`, {
        headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
        signal: AbortSignal.timeout(5000),
      });
      const latencyMs = Date.now() - start;
      const json = await res.json().catch(() => null);

      return reply.send({
        success: res.ok,
        serverIp: ip,
        deltaReachable: res.ok,
        latencyMs,
        deltaServerTime: json?.result?.server_time ?? json?.result?.epoch,
      });
    } catch (err: any) {
      return reply.status(503).send({
        success: false,
        serverIp: ip,
        deltaReachable: false,
        error: err?.message || 'Failed to ping Delta Exchange',
      });
    }
  });

  // Server-side signed relay for authenticated Delta calls (key+secret from env, never the browser).
  fastify.get('/signed', async (request, reply) => {
    const qp = (request.query || {}) as { path?: string; query?: string };
    const path = qp.path;
    const query = qp.query || '';
    if (!path || !path.startsWith('/v2/')) {
      return reply.status(400).send({ success: false, error: 'path must start with /v2/' });
    }
    const key = process.env.DELTA_API_KEY;
    const secret = process.env.DELTA_API_SECRET;
    if (!key || !secret) {
      return reply.status(503).send({ success: false, error: 'Delta credentials not configured on server' });
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const q = query ? '?' + query.replace(/^\?/, '') : ''; // client signs with the '?'-prefixed query
    const sig = signDelta(secret, 'GET', ts, path, q);
    try {
      const upstream = await fetch(`${DELTA_BASE}${path}${q}`, {
        headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
        signal: AbortSignal.timeout(12_000),
      });
      const data = await upstream.json().catch(() => null);
      return reply.status(upstream.status).send(data ?? { success: false, error: 'Empty upstream response' });
    } catch (err: any) {
      return reply.status(502).send({ success: false, error: `Failed to reach Delta: ${err?.message || 'timeout'}` });
    }
  });
};
