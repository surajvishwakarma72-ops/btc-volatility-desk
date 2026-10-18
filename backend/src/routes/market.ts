import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { db, marketTimeseries, optionFlowBuckets, indicatorSnapshots } from '../db/index.js';

/**
 * Market Data & Historical Time-Series Routes
 * 
 * Endpoints:
 * - GET /api/v1/market/candles       Historical OHLCV / IV candles (from market_timeseries)
 * - GET /api/v1/market/flow          15-minute aggregated options buy/sell flow buckets
 * - GET /api/v1/market/indicators    5-minute indicator snapshots (term structure, skew, forward vol)
 * - GET /api/v1/market/symbols       List available symbols
 */
export const marketRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/market/candles - Historical OHLCV candles
  fastify.get('/candles', async (request, reply) => {
    const {
      symbol = 'BTCUSDT',
      interval = '1d',
      from,
      to,
      limit = 500,
    } = request.query as {
      symbol?: string;
      interval?: string;
      from?: string;
      to?: string;
      limit?: number;
    };

    const conditions = [
      eq(marketTimeseries.symbol, symbol),
      eq(marketTimeseries.interval, interval),
    ];

    if (from) conditions.push(gte(marketTimeseries.time, new Date(from)));
    if (to) conditions.push(lte(marketTimeseries.time, new Date(to)));

    const candles = await db
      .select()
      .from(marketTimeseries)
      .where(and(...conditions))
      .orderBy(desc(marketTimeseries.time))
      .limit(Number(limit));

    // Return chronological order (oldest first) for charting
    return {
      success: true,
      count: candles.length,
      data: candles.reverse(),
    };
  });

  // GET /api/v1/market/flow - 15-minute option flow buckets
  fastify.get('/flow', async (request, reply) => {
    const {
      symbol = 'BTC',
      from,
      to,
      limit = 200,
    } = request.query as {
      symbol?: string;
      from?: string;
      to?: string;
      limit?: number;
    };

    const conditions = [eq(optionFlowBuckets.symbol, symbol)];
    if (from) conditions.push(gte(optionFlowBuckets.time, new Date(from)));
    if (to) conditions.push(lte(optionFlowBuckets.time, new Date(to)));

    const flow = await db
      .select()
      .from(optionFlowBuckets)
      .where(and(...conditions))
      .orderBy(desc(optionFlowBuckets.time))
      .limit(Number(limit));

    return {
      success: true,
      count: flow.length,
      data: flow.reverse(),
    };
  });

  // GET /api/v1/market/indicators - 5-minute indicator snapshots
  fastify.get('/indicators', async (request, reply) => {
    const {
      symbol = 'BTCUSDT',
      from,
      to,
      limit = 200,
    } = request.query as {
      symbol?: string;
      from?: string;
      to?: string;
      limit?: number;
    };

    const conditions = [eq(indicatorSnapshots.symbol, symbol)];
    if (from) conditions.push(gte(indicatorSnapshots.recordedAt, new Date(from)));
    if (to) conditions.push(lte(indicatorSnapshots.recordedAt, new Date(to)));

    const snaps = await db
      .select()
      .from(indicatorSnapshots)
      .where(and(...conditions))
      .orderBy(desc(indicatorSnapshots.recordedAt))
      .limit(Number(limit));

    return {
      success: true,
      count: snaps.length,
      data: snaps.reverse(),
    };
  });

  // GET /api/v1/market/symbols - Distinct available symbols in market_timeseries
  fastify.get('/symbols', async (_request, reply) => {
    const distinct = await db
      .selectDistinct({ symbol: marketTimeseries.symbol })
      .from(marketTimeseries);

    return {
      success: true,
      data: distinct.map((d) => d.symbol),
    };
  });

  // GET /api/v1/market/status - Real-time ingestion workers health & live prices
  fastify.get('/status', async (_request, reply) => {
    const { workerManager } = await import('../services/index.js');
    return {
      success: true,
      timestamp: new Date().toISOString(),
      workers: workerManager.getStatus(),
    };
  });
};

