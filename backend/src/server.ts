import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { apiV1Routes } from './routes/index.js';

/**
 * Fastify Application Factory
 * 
 * Configures core plugins, WebSocket handlers, and API routes.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  // Cross-Origin Resource Sharing
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  // Native WebSocket support on same port
  await app.register(websocket);

  // Health check endpoint
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Mount API v1 router
  await app.register(apiV1Routes, { prefix: '/api/v1' });

  return app;
}
