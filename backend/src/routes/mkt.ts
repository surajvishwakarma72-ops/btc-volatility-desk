import type { FastifyPluginAsync } from 'fastify';
import { isAllowed } from '../lib/upstream-allowlist.js';

/**
 * Public market-data gateway. GET /api/v1/mkt?u=<encoded absolute https url>.
 * Validates the URL against the allowlist, fetches it from the server's
 * whitelisted IP, caches briefly, and returns the upstream body verbatim.
 */
interface CacheEntry { at: number; status: number; contentType: string; body: Buffer }
const cache = new Map<string, CacheEntry>();

function ttlFor(url: string): number {
  if (url.includes('/history/candles') || url.includes('get_volatility_index_data') || url.includes('/klines') || url.includes('.zip')) return 30_000;
  return 2_000; // quotes / orderbook / tickers
}

export const marketGatewayRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const u = (request.query as { u?: string }).u;
    if (!u || typeof u !== 'string') {
      return reply.status(400).send({ success: false, error: 'Missing ?u= target url' });
    }
    if (!isAllowed(u)) {
      return reply.status(403).send({ success: false, error: 'Target not in allowlist' });
    }

    const now = Date.now();
    const hit = cache.get(u);
    if (hit && now - hit.at < ttlFor(u)) {
      return reply.status(hit.status).type(hit.contentType).send(hit.body);
    }

    try {
      const upstream = await fetch(u, {
        headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
        signal: AbortSignal.timeout(12_000),
      });
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      const body = Buffer.from(await upstream.arrayBuffer());
      cache.set(u, { at: now, status: upstream.status, contentType, body });
      if (cache.size > 500) { const first = cache.keys().next().value; if (first) cache.delete(first); }
      return reply.status(upstream.status).type(contentType).send(body);
    } catch (err: any) {
      if (hit) return reply.status(hit.status).type(hit.contentType).send(hit.body); // serve stale on upstream failure
      return reply.status(502).send({ success: false, error: `Upstream fetch failed: ${err?.message || 'timeout'}` });
    }
  });
};
