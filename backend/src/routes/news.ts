import type { FastifyPluginAsync } from 'fastify';
import { authenticate } from '../lib/authenticate.js';
import { newsWatcher } from '../services/news/index.js';

/**
 * /api/v1/news. Reading is public market information, like the other market feeds.
 * Acknowledging a popup needs the desk login.
 */
export const newsRoutes: FastifyPluginAsync = async (fastify) => {
  // Unacknowledged CRITICAL/HIGH alerts (the popup queue), so a tab that was closed or asleep shows what it missed.
  fastify.get('/active', async () => ({ success: true, events: newsWatcher.active() }));

  fastify.get('/events', async (request) => {
    const q = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return { success: true, events: newsWatcher.recent(limit) };
  });

  // "No new entries" window, feed health per source, the current 15-min move.
  fastify.get('/status', async () => ({ success: true, ...newsWatcher.status() }));

  // Local test stack only (docker-compose.test.yml sets NEWS_DEMO=true): fire a labelled test alert through the real path.
  if (process.env.NEWS_DEMO === 'true') {
    fastify.post('/demo', async (request) => {
      const q = (request.query as { kind?: string }).kind;
      if (q === 'trip') return { success: true, event: await newsWatcher.raise({ kind: 'tripwire', severity: 'HIGH', category: 'crash', reason: 'Compression break downward (DEMO)', title: 'DEMO: BTC closed at 76,410, below the quiet range 77,050–78,620 (Squeeze), with volatility expanding.', message: 'Exit now: don’t wait for the 1:1 stop.' }) };
      return { success: true, event: await newsWatcher.demo(q === 'fall' ? 'fall' : 'hack') };
    });
  }

  fastify.post('/:id/ack', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const e = await newsWatcher.ack(String(id || ''));
    if (!e) return reply.status(404).send({ success: false, error: 'No such alert' });
    return { success: true, event: e };
  });
};
