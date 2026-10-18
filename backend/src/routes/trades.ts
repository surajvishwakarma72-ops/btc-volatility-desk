import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { db, trades, tradeLegs } from '../db/index.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Trades & Strangle Execution Routes
 * 
 * Endpoints:
 * - GET    /api/v1/trades             List historical and active strangle trades
 * - GET    /api/v1/trades/active      Get currently open strangle (replaces legacy v99_trade)
 * - GET    /api/v1/trades/:id         Get specific trade with attached legs
 * - POST   /api/v1/trades             Record new trade entry
 * - PATCH  /api/v1/trades/:id         Update or close a trade position
 * - DELETE /api/v1/trades/:id         Delete trade
 */
export const tradeRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/trades - List trades with optional status filter
  fastify.get('/', async (request, reply) => {
    const { status, limit = 50, offset = 0 } = request.query as {
      status?: string;
      limit?: number;
      offset?: number;
    };

    const conditions = [eq(trades.userId, DEFAULT_USER_ID)];
    if (status) {
      conditions.push(eq(trades.status, status));
    }

    const tradeList = await db
      .select()
      .from(trades)
      .where(and(...conditions))
      .orderBy(desc(trades.entryTime))
      .limit(Number(limit))
      .offset(Number(offset));

    return {
      success: true,
      count: tradeList.length,
      data: tradeList,
    };
  });

  // GET /api/v1/trades/active - Get currently open strangle
  fastify.get('/active', async (_request, reply) => {
    const active = await db
      .select()
      .from(trades)
      .where(and(eq(trades.userId, DEFAULT_USER_ID), eq(trades.status, 'OPEN')))
      .orderBy(desc(trades.entryTime))
      .limit(1);

    if (!active.length) {
      return { success: true, data: null };
    }

    const trade = active[0];
    const legs = await db
      .select()
      .from(tradeLegs)
      .where(eq(tradeLegs.tradeId, trade.id));

    return {
      success: true,
      data: {
        ...trade,
        legs,
      },
    };
  });

  // GET /api/v1/trades/:id - Get specific trade with its legs
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const tradeRes = await db
      .select()
      .from(trades)
      .where(and(eq(trades.id, id), eq(trades.userId, DEFAULT_USER_ID)))
      .limit(1);

    if (!tradeRes.length) {
      return reply.status(404).send({ success: false, error: 'Trade not found' });
    }

    const trade = tradeRes[0];
    const legs = await db
      .select()
      .from(tradeLegs)
      .where(eq(tradeLegs.tradeId, trade.id));

    return {
      success: true,
      data: {
        ...trade,
        legs,
      },
    };
  });

  // POST /api/v1/trades - Record new trade
  fastify.post('/', async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.callStrike || !body.putStrike || !body.expiryDate) {
      return reply.status(400).send({
        success: false,
        error: 'Missing required trade parameters: callStrike, putStrike, expiryDate',
      });
    }

    const tradeId = crypto.randomUUID();
    const newTrade = {
      id: tradeId,
      userId: DEFAULT_USER_ID,
      strategy: body.strategy || 'SHORT_STRANGLE',
      status: body.status || 'OPEN',
      underlying: body.underlying || 'BTC',
      expiryDate: new Date(body.expiryDate),
      callStrike: String(body.callStrike),
      putStrike: String(body.putStrike),
      entryTime: body.entryTime ? new Date(body.entryTime) : new Date(),
      exitTime: body.exitTime ? new Date(body.exitTime) : null,
      entrySpot: body.entrySpot ? String(body.entrySpot) : null,
      exitSpot: body.exitSpot ? String(body.exitSpot) : null,
      entryIv: body.entryIv ? String(body.entryIv) : null,
      exitIv: body.exitIv ? String(body.exitIv) : null,
      contracts: String(body.contracts || '0.01'),
      realizedPnl: body.realizedPnl ? String(body.realizedPnl) : null,
      exitReason: body.exitReason || null,
      entryGreeks: body.entryGreeks || {},
      pnlAttribution: body.pnlAttribution || {},
    };

    await db.insert(trades).values(newTrade);

    // If legs are provided, insert them
    if (Array.isArray(body.legs) && body.legs.length > 0) {
      const legRows = body.legs.map((l: any) => ({
        id: crypto.randomUUID(),
        tradeId: tradeId,
        legType: l.legType, // 'CALL' | 'PUT'
        strike: String(l.strike),
        entryPremium: l.entryPremium ? String(l.entryPremium) : null,
        exitPremium: l.exitPremium ? String(l.exitPremium) : null,
        entryIv: l.entryIv ? String(l.entryIv) : null,
        exitIv: l.exitIv ? String(l.exitIv) : null,
        status: l.status || 'OPEN',
        stopLossLevel: l.stopLossLevel ? String(l.stopLossLevel) : null,
        triggeredExit: Boolean(l.triggeredExit),
      }));

      await db.insert(tradeLegs).values(legRows);
    }

    return reply.status(201).send({
      success: true,
      data: newTrade,
    });
  });

  // PATCH /api/v1/trades/:id - Update or close a trade
  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (body.status !== undefined) updates.status = body.status;
    if (body.exitTime !== undefined) updates.exitTime = body.exitTime ? new Date(body.exitTime) : null;
    if (body.exitSpot !== undefined) updates.exitSpot = body.exitSpot ? String(body.exitSpot) : null;
    if (body.exitIv !== undefined) updates.exitIv = body.exitIv ? String(body.exitIv) : null;
    if (body.realizedPnl !== undefined) updates.realizedPnl = body.realizedPnl ? String(body.realizedPnl) : null;
    if (body.exitReason !== undefined) updates.exitReason = body.exitReason;
    if (body.pnlAttribution !== undefined) updates.pnlAttribution = body.pnlAttribution;

    const updated = await db
      .update(trades)
      .set(updates)
      .where(and(eq(trades.id, id), eq(trades.userId, DEFAULT_USER_ID)))
      .returning();

    if (!updated.length) {
      return reply.status(404).send({ success: false, error: 'Trade not found' });
    }

    return {
      success: true,
      data: updated[0],
    };
  });

  // DELETE /api/v1/trades/:id - Delete trade
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const deleted = await db
      .delete(trades)
      .where(and(eq(trades.id, id), eq(trades.userId, DEFAULT_USER_ID)))
      .returning({ id: trades.id });

    if (!deleted.length) {
      return reply.status(404).send({ success: false, error: 'Trade not found' });
    }

    return {
      success: true,
      message: 'Trade deleted successfully',
      id: deleted[0].id,
    };
  });
};
