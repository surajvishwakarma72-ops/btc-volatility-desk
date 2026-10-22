import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './auth.js';
import { tradeRoutes } from './trades.js';
import { nightRoutes } from './nights.js';
import { drawingRoutes } from './drawings.js';
import { preferenceRoutes } from './preferences.js';
import { marketRoutes } from './market.js';
import { alertRoutes } from './alerts.js';
import { deltaRoutes } from './delta.js';
import { migrationRoutes } from './migration.js';
import { telemetryRoutes } from './telemetry.js';
import { marketGatewayRoutes } from './mkt.js';
import { macroStressRoutes } from './macro-stress.js';

/**
 * Primary API v1 Router Registration
 *
 * Mounts all domain route stubs under /api/v1/*
 */
export const apiV1Routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(authRoutes, { prefix: '/auth' });
  await fastify.register(tradeRoutes, { prefix: '/trades' });
  await fastify.register(nightRoutes, { prefix: '/nights' });
  await fastify.register(drawingRoutes, { prefix: '/drawings' });
  await fastify.register(preferenceRoutes, { prefix: '/preferences' });
  await fastify.register(marketRoutes, { prefix: '/market' });
  await fastify.register(alertRoutes, { prefix: '/alerts' });
  await fastify.register(deltaRoutes, { prefix: '/delta' });
  await fastify.register(migrationRoutes, { prefix: '/migration' });
  await fastify.register(telemetryRoutes, { prefix: '/telemetry' });
  await fastify.register(marketGatewayRoutes, { prefix: '/mkt' });
  await fastify.register(macroStressRoutes, { prefix: '/macro' });
};
