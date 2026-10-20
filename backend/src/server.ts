import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { apiV1Routes } from './routes/index.js';
import { handleDeltaProxy } from './routes/delta.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    bodyLimit: 1_048_576,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Cross-Origin Resource Sharing
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: corsOrigins.length ? corsOrigins : ['http://localhost:3000', 'http://localhost:4000'],
    credentials: true,
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err) || err.validation) {
      return reply.status(400).send({
        success: false,
        error: 'Validation failed',
        details: err.validation ?? err.issues ?? undefined,
      });
    }
    req.log.error(err);
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    return reply.status(status).send({
      success: false,
      error: status === 500 ? 'Internal server error' : err.message,
    });
  });

  // Native WebSocket support on same port
  await app.register(websocket);

  // Health check endpoint
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Mount API v1 router
  await app.register(apiV1Routes, { prefix: '/api/v1' });

  // Direct compatibility route for Delta Exchange signed requests relay
  app.get('/api/delta-proxy', handleDeltaProxy);
  app.post('/api/delta-proxy', handleDeltaProxy);

  // Serve static frontend if built (for unified cloud deployment on Railway/Render)
  const possibleDistPaths = [
    path.resolve(__dirname, '../../frontend/dist'),
    path.resolve(__dirname, '../public'),
    path.resolve(process.cwd(), 'frontend/dist'),
    path.resolve(process.cwd(), '../frontend/dist'),
  ];
  const frontendDist = possibleDistPaths.find((p) => fs.existsSync(p));

  if (frontendDist) {
    app.log.info(`Serving static frontend from: ${frontendDist}`);
    await app.register(fastifyStatic, {
      root: frontendDist,
      prefix: '/',
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        return reply.status(404).send({ success: false, error: 'API endpoint not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // 24/7 Background Market Ingestion & Alert Workers
  app.addHook('onReady', async () => {
    const { workerManager } = await import('./services/index.js');
    workerManager.startAll();
  });

  app.addHook('onClose', async () => {
    const { workerManager } = await import('./services/index.js');
    workerManager.stopAll();
  });

  return app;
}
