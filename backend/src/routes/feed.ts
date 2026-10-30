import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getFeedStatus } from '../services/delta-feed.js';

export const feedRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/feed/status — returns {running: boolean, last_poll_at: string|null, error_count: number}
  const statusHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    const status = getFeedStatus();
    return reply.status(200).send({
      running: status.running,
      last_poll_at: status.last_poll_at,
      error_count: status.error_count,
    });
  };

  fastify.get('/status', statusHandler);
  fastify.get('/feed/status', statusHandler);
  fastify.get('/', statusHandler);
};
