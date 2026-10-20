import type { FastifyPluginAsync } from 'fastify';

/**
 * Economic calendar relay (replaces the old Vercel /api/cal function).
 * Fetches ForexFactory's free weekly JSON from the server and caches it for 1h.
 */
const FF = {
  this: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  next: 'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
};
const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 60 * 60 * 1000;

export const calRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/cal', async (request, reply) => {
    const week = (request.query as { week?: string }).week;
    if (week !== 'this' && week !== 'next') {
      return reply.status(400).send({ success: false, error: 'week must be "this" or "next"' });
    }
    const now = Date.now();
    const hit = cache.get(week);
    if (hit && now - hit.at < TTL) return reply.send(hit.data);
    try {
      const res = await fetch(FF[week], { headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.timeout(12_000) });
      const data = await res.json();
      cache.set(week, { at: now, data });
      return reply.send(data);
    } catch (err: any) {
      if (hit) return reply.send(hit.data);
      return reply.status(502).send({ success: false, error: `Calendar fetch failed: ${err?.message || 'timeout'}` });
    }
  });
};
