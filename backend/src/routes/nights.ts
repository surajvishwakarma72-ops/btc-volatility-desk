import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and, sql } from 'drizzle-orm';
import { db, nightlyReviews } from '../db/index.js';
import { nightsQuery, dateParam, nightCreate } from '../schemas.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Nightly Reviews & Day Coach Calendar History Routes
 * 
 * Endpoints:
 * - GET  /api/v1/nights               List all past session night reviews (ordered by sessionDate desc)
 * - GET  /api/v1/nights/stats         Aggregate analytics: win rates, verdict counts, exit hour distribution
 * - GET  /api/v1/nights/:date         Get specific night review by YYYY-MM-DD
 * - POST /api/v1/nights               Create or update a night review
 * - DELETE /api/v1/nights/:date       Delete a night review
 */
export const nightRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/nights - List all reviews
  fastify.get('/', { schema: { querystring: nightsQuery } }, async (request) => {
    const { verdict, outcome, limit = 100, offset = 0 } = request.query as {
      verdict?: string;
      outcome?: string;
      limit?: number;
      offset?: number;
    };

    const conditions = [eq(nightlyReviews.userId, DEFAULT_USER_ID)];
    if (verdict) conditions.push(eq(nightlyReviews.verdict, verdict));
    if (outcome) conditions.push(eq(nightlyReviews.outcome, outcome));

    const reviews = await db
      .select()
      .from(nightlyReviews)
      .where(and(...conditions))
      .orderBy(desc(nightlyReviews.sessionDate))
      .limit(Number(limit))
      .offset(Number(offset));

    return {
      success: true,
      count: reviews.length,
      data: reviews,
    };
  });

  // GET /api/v1/nights/stats - Aggregated stats for the Day & Season Coach
  fastify.get('/stats', async () => {
    const all = await db
      .select()
      .from(nightlyReviews)
      .where(eq(nightlyReviews.userId, DEFAULT_USER_ID));

    const total = all.length;
    let profitCount = 0;
    let lossCount = 0;
    let scratchCount = 0;
    const verdictCounts: Record<string, number> = { SELL_FULL: 0, SELL_HALF: 0, NO_TRADE: 0 };
    const exitHourCounts: Record<number, number> = {};

    for (const r of all) {
      if (r.outcome === 'PROFIT') profitCount++;
      else if (r.outcome === 'LOSS') lossCount++;
      else if (r.outcome === 'SCRATCH') scratchCount++;

      if (r.verdict && verdictCounts[r.verdict] !== undefined) {
        verdictCounts[r.verdict]++;
      }
      if (r.exitHour !== null && r.exitHour !== undefined) {
        exitHourCounts[r.exitHour] = (exitHourCounts[r.exitHour] || 0) + 1;
      }
    }

    const tradeDays = profitCount + lossCount + scratchCount;
    const winRate = tradeDays > 0 ? Number(((profitCount / tradeDays) * 100).toFixed(2)) : 0;

    return {
      success: true,
      data: {
        totalSessions: total,
        tradeDays,
        profitCount,
        lossCount,
        scratchCount,
        winRatePercent: winRate,
        verdictBreakdown: verdictCounts,
        exitHourDistribution: exitHourCounts,
      },
    };
  });

  // GET /api/v1/nights/:date - Get specific night by date (YYYY-MM-DD)
  fastify.get('/:date', { schema: { params: dateParam } }, async (request, reply) => {
    const { date } = request.params as { date: string };

    const review = await db
      .select()
      .from(nightlyReviews)
      .where(and(eq(nightlyReviews.userId, DEFAULT_USER_ID), eq(nightlyReviews.sessionDate, date)))
      .limit(1);

    if (!review.length) {
      return reply.status(404).send({ success: false, error: `No night review found for date ${date}` });
    }

    return {
      success: true,
      data: review[0],
    };
  });

  // POST /api/v1/nights - Upsert a night review
  fastify.post('/', { schema: { body: nightCreate } }, async (request, reply) => {
    const body = request.body as any;

    const reviewData = {
      userId: DEFAULT_USER_ID,
      sessionDate: body.sessionDate,
      verdict: body.verdict,
      outcome: body.outcome || null,
      iv1730: body.iv1730 ? String(body.iv1730) : null,
      ivNyOpen: body.ivNyOpen ? String(body.ivNyOpen) : null,
      ivExit: body.ivExit ? String(body.ivExit) : null,
      speedVsIv: body.speedVsIv ? String(body.speedVsIv) : null,
      adxTrend: body.adxTrend || null,
      exitHour: Number.isInteger(body.exitHour) ? Number(body.exitHour) : null,
      eventTags: Array.isArray(body.eventTags) ? body.eventTags : [],
      notes: body.notes || null,
    };

    const inserted = await db
      .insert(nightlyReviews)
      .values({
        id: crypto.randomUUID(),
        ...reviewData,
      })
      .onConflictDoUpdate({
        target: [nightlyReviews.userId, nightlyReviews.sessionDate],
        set: {
          verdict: sql`excluded.verdict`,
          outcome: sql`excluded.outcome`,
          iv1730: sql`excluded.iv_1730`,
          ivNyOpen: sql`excluded.iv_ny_open`,
          ivExit: sql`excluded.iv_exit`,
          speedVsIv: sql`excluded.speed_vs_iv`,
          adxTrend: sql`excluded.adx_trend`,
          exitHour: sql`excluded.exit_hour`,
          eventTags: sql`excluded.event_tags`,
          notes: sql`excluded.notes`,
        },
      })
      .returning();

    return reply.status(200).send({
      success: true,
      data: inserted[0],
    });
  });

  // DELETE /api/v1/nights/:date - Delete a review
  fastify.delete('/:date', { schema: { params: dateParam } }, async (request, reply) => {
    const { date } = request.params as { date: string };

    const deleted = await db
      .delete(nightlyReviews)
      .where(and(eq(nightlyReviews.userId, DEFAULT_USER_ID), eq(nightlyReviews.sessionDate, date)))
      .returning({ sessionDate: nightlyReviews.sessionDate });

    if (!deleted.length) {
      return reply.status(404).send({ success: false, error: `No night review found for date ${date}` });
    }

    return {
      success: true,
      message: `Night review for ${date} removed successfully`,
    };
  });
};
