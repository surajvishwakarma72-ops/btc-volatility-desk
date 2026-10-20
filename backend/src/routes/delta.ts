import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Delta Exchange India Authenticated Gateway & Relay
 * 
 * Provides:
 * - GET/POST /api/v1/delta/proxy       Relay HMAC-signed requests to api.india.delta.exchange from the server's static IP
 * - GET      /api/v1/delta/ip          Retrieve the server's public outbound IP for easy whitelisting on Delta
 * - GET      /api/v1/delta/status      Verify gateway health and reachability to Delta
 */

const DELTA_BASE = 'https://api.india.delta.exchange';

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

/**
 * Core Proxy Handler for Delta Exchange signed requests
 */
export async function handleDeltaProxy(request: FastifyRequest, reply: FastifyReply) {
  const query = (request.query || {}) as Record<string, string | undefined>;
  const body = (request.body || {}) as Record<string, any>;

  const path = query.path || body.path;
  const queryString = query.query || body.query || '';

  if (!path || typeof path !== 'string' || !path.startsWith('/v2/')) {
    return reply.status(400).send({
      success: false,
      error: 'Invalid or missing target path. Path must start with /v2/',
    });
  }

  // Support both standard and x-prefixed authentication headers
  const apiKey = (request.headers['x-api-key'] || request.headers['api-key']) as string | undefined;
  const timestamp = (request.headers['x-ts'] || request.headers['timestamp']) as string | undefined;
  const signature = (request.headers['x-sig'] || request.headers['signature']) as string | undefined;

  if (!apiKey || !timestamp || !signature) {
    return reply.status(400).send({
      success: false,
      error: 'Missing required authentication headers (api-key, timestamp, signature)',
    });
  }

  const cleanQuery = queryString ? (queryString.startsWith('?') ? queryString : '?' + queryString) : '';
  const targetUrl = `${DELTA_BASE}${path}${cleanQuery}`;

  try {
    const upstreamRes = await fetch(targetUrl, {
      method: request.method === 'POST' ? 'POST' : 'GET',
      headers: {
        'api-key': apiKey,
        'timestamp': String(timestamp),
        'signature': signature,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'BTC-Volatility-Desk-Backend/1.0',
      },
      body: request.method === 'POST' && body.payload ? JSON.stringify(body.payload) : undefined,
      signal: AbortSignal.timeout(12000),
    });

    const data = await upstreamRes.json().catch(() => null);
    return reply.status(upstreamRes.status).send(data ?? { success: false, error: 'Empty upstream response from Delta' });
  } catch (err: any) {
    return reply.status(502).send({
      success: false,
      error: `Failed to reach Delta Exchange: ${err?.message || 'Gateway Timeout'}`,
    });
  }
}

export const deltaRoutes: FastifyPluginAsync = async (fastify) => {
  // Proxy GET & POST
  fastify.get('/proxy', handleDeltaProxy);
  fastify.post('/proxy', handleDeltaProxy);

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
};
