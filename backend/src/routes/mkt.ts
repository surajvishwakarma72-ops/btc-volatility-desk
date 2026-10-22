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
      // Follow redirects MANUALLY, re-validating each hop against the allowlist so an
      // allowlisted host cannot 3xx us to an internal/metadata URL (SSRF-via-redirect).
      let target = u;
      let upstream: Awaited<ReturnType<typeof fetch>> | null = null;
      for (let hop = 0; hop < 4; hop++) {
        if (!isAllowed(target)) {
          return reply.status(403).send({ success: false, error: 'Redirect target not in allowlist' });
        }
        upstream = await fetch(target, {
          redirect: 'manual',
          headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
          signal: AbortSignal.timeout(12_000),
        });
        if (upstream.status >= 300 && upstream.status < 400) {
          const loc = upstream.headers.get('location');
          if (!loc) break;
          target = new URL(loc, target).toString();
          continue;
        }
        break;
      }
      if (!upstream) return reply.status(502).send({ success: false, error: 'No upstream response' });

      // Serve only a safe content-type set from our own origin; coerce anything else to
      // octet-stream and forbid MIME sniffing so a hostile upstream cannot XSS us.
      const SAFE = new Set(['application/json', 'text/csv', 'application/octet-stream', 'application/zip']);
      const rawCt = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const contentType = SAFE.has(rawCt) ? rawCt : 'application/octet-stream';
      const body = Buffer.from(await upstream.arrayBuffer());
      // Only cache successful responses — caching a 429/503 would poison the TTL window.
      if (upstream.ok) {
        cache.set(u, { at: Date.now(), status: upstream.status, contentType, body });
        if (cache.size > 300) {
          const cut = Date.now() - 60_000;
          for (const [k, v] of cache.entries()) {
            if (v.at < cut) cache.delete(k);
          }
          if (cache.size > 500) {
            const first = cache.keys().next().value;
            if (first) cache.delete(first);
          }
        }
      }
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.status(upstream.status).type(contentType).send(body);
    } catch (err: any) {
      if (hit) { reply.header('X-Content-Type-Options', 'nosniff'); return reply.status(hit.status).type(hit.contentType).send(hit.body); }
      return reply.status(502).send({ success: false, error: `Upstream fetch failed: ${err?.message || 'timeout'}` });
    }
  });
};
