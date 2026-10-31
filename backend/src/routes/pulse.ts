import type { FastifyPluginAsync } from 'fastify';
import { pulseEngine } from '../services/pulse/pulse-engine.js';

/** Read-only status of the Strangle Pulse collector. Needs the desk JWT. */
export const pulseRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };

  fastify.get('/status', auth, async () => ({ success: true, ...pulseEngine.status() }));
};
