import fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { apiV1Routes } from './routes/index.js';
import { calRoutes } from './routes/cal.js';

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
    // Behind Caddy (the only thing that can reach app:4000), trust X-Forwarded-For so
    // req.ip is the real client — makes per-client rate-limiting + the allowList work.
    trustProxy: true,
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

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX) || 600, // requests
    timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
    allowList: ['127.0.0.1'], // Caddy/health checks on the local docker network
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

  // Economic calendar relay — no prefix; frontend calls /api/cal (not /api/v1/cal)
  await app.register(calRoutes);

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
    // Bridge: ensure the default desk user exists so writes don't FK-fail on a
    // fresh DB. Phase B replaces DEFAULT_USER_ID with the authenticated user.
    const { db, users } = await import('./db/index.js');
    try {
      await db.insert(users).values({
        id: '00000000-0000-0000-0000-000000000001',
        email: 'desk@local',
        passwordHash: '!',
        displayName: 'Desk',
        role: 'trader',
      }).onConflictDoNothing();
      app.log.info('Default desk user ensured.');
    } catch (err) {
      app.log.error({ err }, 'Failed to seed default user');
    }

    const { workerManager } = await import('./services/index.js');
    workerManager.startAll();
  });

  app.addHook('onClose', async () => {
    const { workerManager } = await import('./services/index.js');
    workerManager.stopAll();
  });

  return app;
}
