import type { FastifyPluginAsync } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db, chartDrawings } from '../db/index.js';
import { drawingsQuery, idParam, drawingCreate, drawingUpdate } from '../schemas.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Chart Drawings & Annotations Routes
 * 
 * Endpoints:
 * - GET    /api/v1/drawings           List all drawings and session anchors for symbol
 * - POST   /api/v1/drawings           Create new chart drawing
 * - PUT    /api/v1/drawings/:id       Update drawing geometry or styling
 * - DELETE /api/v1/drawings/:id       Delete drawing
 */
export const drawingRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/drawings - List drawings
  fastify.get('/', { schema: { querystring: drawingsQuery } }, async (request, reply) => {
    const { symbol = 'BTCUSDT' } = request.query as { symbol?: string };

    const drawings = await db
      .select()
      .from(chartDrawings)
      .where(and(eq(chartDrawings.userId, DEFAULT_USER_ID), eq(chartDrawings.symbol, symbol)));

    return {
      success: true,
      count: drawings.length,
      data: drawings,
    };
  });

  // POST /api/v1/drawings - Save new drawing
  fastify.post('/', { schema: { body: drawingCreate } }, async (request, reply) => {
    const body = request.body as any;

    const newDrawing = {
      id: crypto.randomUUID(),
      userId: DEFAULT_USER_ID,
      symbol: body.symbol || 'BTCUSDT',
      drawingType: body.drawingType || 'HORIZONTAL_RAY',
      points: body.points,
      style: body.style || { color: '#2F81F7', lineWidth: 1 },
      label: body.label || null,
      updatedAt: new Date(),
    };

    const inserted = await db.insert(chartDrawings).values(newDrawing).returning();

    return reply.status(201).send({
      success: true,
      data: inserted[0],
    });
  });

  // PUT /api/v1/drawings/:id - Update drawing
  fastify.put('/:id', { schema: { params: idParam, body: drawingUpdate } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const updates: Record<string, any> = {
      updatedAt: new Date(),
    };

    if (body.points) updates.points = body.points;
    if (body.style) updates.style = body.style;
    if (body.label !== undefined) updates.label = body.label;
    if (body.drawingType) updates.drawingType = body.drawingType;

    const updated = await db
      .update(chartDrawings)
      .set(updates)
      .where(and(eq(chartDrawings.id, id), eq(chartDrawings.userId, DEFAULT_USER_ID)))
      .returning();

    if (!updated.length) {
      return reply.status(404).send({ success: false, error: 'Drawing not found' });
    }

    return {
      success: true,
      data: updated[0],
    };
  });

  // DELETE /api/v1/drawings/:id - Delete drawing
  fastify.delete('/:id', { schema: { params: idParam } }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const deleted = await db
      .delete(chartDrawings)
      .where(and(eq(chartDrawings.id, id), eq(chartDrawings.userId, DEFAULT_USER_ID)))
      .returning({ id: chartDrawings.id });

    if (!deleted.length) {
      return reply.status(404).send({ success: false, error: 'Drawing not found' });
    }

    return {
      success: true,
      message: 'Drawing deleted successfully',
      id: deleted[0].id,
    };
  });
};
