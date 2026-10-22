import type { FastifyPluginAsync } from 'fastify';
import { macroStressWorker } from '../services/macro-stress-worker.js';

export const macroStressRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/macro/stress
  fastify.get('/stress', async (_request, reply) => {
    try {
      const snapshot = macroStressWorker.getSnapshot();
      return reply.send({ success: true, ...snapshot });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        error: `Failed to compute macro stress: ${err?.message || 'unknown'}`,
      });
    }
  });

  // POST /api/v1/macro/weights (re-fit weights weekly or on-demand)
  fastify.post('/weights', async (request, reply) => {
    try {
      const body = request.body as any;
      if (!body || typeof body !== 'object') {
        return reply.status(400).send({ success: false, error: 'Expected JSON body with weights' });
      }
      macroStressWorker.setWeights(body);
      return reply.send({ success: true, weights: macroStressWorker.weights });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to update weights' });
    }
  });
};
