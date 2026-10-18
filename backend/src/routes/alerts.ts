import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { db, alertRules, alertLogs } from '../db/index.js';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Alert Rules & Notification History Routes
 * 
 * Endpoints:
 * - GET    /api/v1/alerts/rules       List active alert threshold rules
 * - POST   /api/v1/alerts/rules       Create alert rule
 * - DELETE /api/v1/alerts/rules/:id   Remove alert rule
 * - GET    /api/v1/alerts/history     List triggered alert logs & VolTurn signals
 */
export const alertRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/alerts/rules - List rules
  fastify.get('/rules', async (_request, reply) => {
    const rules = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.userId, DEFAULT_USER_ID))
      .orderBy(desc(alertRules.createdAt));

    return {
      success: true,
      count: rules.length,
      data: rules,
    };
  });

  // POST /api/v1/alerts/rules - Create rule
  fastify.post('/rules', async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.ruleName || !body.ruleType || body.thresholdValue == null) {
      return reply.status(400).send({
        success: false,
        error: 'Missing required fields: ruleName, ruleType, thresholdValue',
      });
    }

    const newRule = {
      id: crypto.randomUUID(),
      userId: DEFAULT_USER_ID,
      ruleName: body.ruleName,
      ruleType: body.ruleType,
      thresholdValue: String(body.thresholdValue),
      channels: Array.isArray(body.channels) ? body.channels : ['telegram', 'ntfy', 'in_app'],
      cooldownSeconds: Number(body.cooldownSeconds) || 300,
      isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
    };

    const inserted = await db.insert(alertRules).values(newRule).returning();

    return reply.status(201).send({
      success: true,
      data: inserted[0],
    });
  });

  // DELETE /api/v1/alerts/rules/:id - Delete rule
  fastify.delete('/rules/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const deleted = await db
      .delete(alertRules)
      .where(and(eq(alertRules.id, id), eq(alertRules.userId, DEFAULT_USER_ID)))
      .returning({ id: alertRules.id });

    if (!deleted.length) {
      return reply.status(404).send({ success: false, error: 'Alert rule not found' });
    }

    return {
      success: true,
      message: 'Alert rule deleted successfully',
      id: deleted[0].id,
    };
  });

  // GET /api/v1/alerts/history - List triggered logs and VolTurn signals
  fastify.get('/history', async (request, reply) => {
    const { channel, limit = 100, offset = 0 } = request.query as {
      channel?: string;
      limit?: number;
      offset?: number;
    };

    const conditions = [eq(alertLogs.userId, DEFAULT_USER_ID)];
    if (channel) conditions.push(eq(alertLogs.channel, channel));

    const logs = await db
      .select()
      .from(alertLogs)
      .where(and(...conditions))
      .orderBy(desc(alertLogs.deliveredAt))
      .limit(Number(limit))
      .offset(Number(offset));

    return {
      success: true,
      count: logs.length,
      data: logs,
    };
  });

  // POST /api/v1/alerts/test - Dispatch test notification
  fastify.post('/test', async (request, reply) => {
    const { alertService } = await import('../services/index.js');
    const body = (request.body as any) || {};
    const channel = body.channel || 'ntfy';
    const topic = body.topic || process.env.NTFY_DEFAULT_TOPIC || 'btc-volatility-desk';

    const sent = await alertService.sendNotification({
      title: '🚨 BTC Volatility Desk Test Alert',
      message: `BTC Spot: $82,015 | Deribit DVOL: 37.84% | Test signal dispatched successfully from Fastify at ${new Date().toLocaleTimeString()} UTC.`,
      channel: channel,
    });

    return {
      success: sent,
      channel,
      ntfyUrl: `https://ntfy.sh/${topic}`,
      message: 'Test notification dispatched and logged to database.',
      timestamp: new Date().toISOString(),
    };
  });
};

