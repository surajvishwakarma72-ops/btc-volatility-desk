import { userId } from '../lib/guards.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getStrikeAlerts, acknowledgeStrikeAlert } from '../services/strike-alerts.js';
import { eq, desc, and } from 'drizzle-orm';
import { db, alertRules, alertLogs } from '../db/index.js';
import { alertRuleCreate, idParam, alertsHistoryQuery, alertTest, registerDevice } from '../schemas.js';


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
  fastify.addHook('preHandler', async (request, reply) => {
    const routeUrl = request.routeOptions?.url || request.url;
    if (
      routeUrl === '/api/v1/alerts' ||
      routeUrl === '/api/v1/alerts/' ||
      routeUrl === '/' ||
      routeUrl === '' ||
      routeUrl.includes('/ack') ||
      request.url.includes('/ack') ||
      request.url === '/api/v1/alerts' ||
      request.url === '/api/v1/alerts/' ||
      request.url.startsWith('/api/v1/alerts?')
    ) {
      return;
    }
    if ((fastify as any).authenticate) {
      await (fastify as any).authenticate(request, reply);
    }
  });

  // GET /api/v1/alerts - returns last 50 alerts, newest first (Task T3.1)
  const handleGetAlerts = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query || {}) as { limit?: string | number };
    const limit = query.limit !== undefined ? Number(query.limit) : 50;
    const alerts = await getStrikeAlerts(limit);

    return reply.status(200).send({
      success: true,
      count: alerts.length,
      alerts,
      data: alerts,
    });
  };

  fastify.get('/', handleGetAlerts);

  // POST /api/v1/alerts/:id/ack - marks acknowledged_at = now() (Task T3.1)
  fastify.post('/:id/ack', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = (request.params || {}) as { id: string };
    if (!id) {
      return reply.status(400).send({ success: false, error: 'Alert ID is required' });
    }

    const updated = await acknowledgeStrikeAlert(id);
    if (!updated) {
      return reply.status(404).send({ success: false, error: 'Alert not found' });
    }

    return reply.status(200).send({
      success: true,
      message: 'Alert acknowledged',
      alert: updated,
      data: updated,
      acknowledged_at: updated.acknowledged_at,
    });
  });

  // GET /api/v1/alerts/rules - List rules
  fastify.get('/rules', async (request) => {
    const rules = await db
      .select()
      .from(alertRules)
      .where(eq(alertRules.userId, userId(request)))
      .orderBy(desc(alertRules.createdAt));

    return {
      success: true,
      count: rules.length,
      data: rules,
    };
  });

  // POST /api/v1/alerts/rules - Create rule
  fastify.post('/rules', { schema: { body: alertRuleCreate } }, async (request, reply) => {
    const body = request.body as any;

    const newRule = {
      id: crypto.randomUUID(),
      userId: userId(request),
      ruleName: body.ruleName,
      ruleType: body.ruleType,
      thresholdValue: String(body.thresholdValue),
      channels: Array.isArray(body.channels) ? body.channels : ['telegram', 'ntfy', 'in_app'],
      cooldownSeconds: Number(body.cooldownSeconds) || 300,
      isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
    };

    const inserted = await db.insert(alertRules).values(newRule).returning();

    const { alertService } = await import('../services/index.js');
    alertService.invalidateRulesCache();

    return reply.status(201).send({
      success: true,
      data: inserted[0],
    });
  });

  // DELETE /api/v1/alerts/rules/:id - Delete rule
  fastify.delete('/rules/:id', { schema: { params: idParam } }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const deleted = await db
      .delete(alertRules)
      .where(and(eq(alertRules.id, id), eq(alertRules.userId, userId(request))))
      .returning({ id: alertRules.id });

    if (!deleted.length) {
      return reply.status(404).send({ success: false, error: 'Alert rule not found' });
    }

    const { alertService } = await import('../services/index.js');
    alertService.invalidateRulesCache();

    return {
      success: true,
      message: 'Alert rule deleted successfully',
      id: deleted[0].id,
    };
  });

  // GET /api/v1/alerts/history - List triggered logs and VolTurn signals
  fastify.get('/history', { schema: { querystring: alertsHistoryQuery } }, async (request) => {
    const { channel, limit = 100, offset = 0 } = request.query as {
      channel?: string;
      limit?: number;
      offset?: number;
    };

    const conditions = [eq(alertLogs.userId, userId(request))];
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
  fastify.post('/test', { schema: { body: alertTest } }, async (request) => {
    const { alertService } = await import('../services/index.js');
    const body = (request.body as any) || {};
    const channel = body.channel || 'ntfy';
    const topic = body.topic || process.env.NTFY_DEFAULT_TOPIC || 'btc-volatility-desk';

    const sent = await alertService.sendNotification({
      title: '🚨 BTC Volatility Desk Test Alert',
      message: `Test signal dispatched at ${new Date().toLocaleTimeString()} UTC.`,
      channels: [channel] as any,
    });

    return {
      success: sent,
      channel,
      ntfyUrl: `https://ntfy.sh/${topic}`,
      message: 'Test notification dispatched and logged to database.',
      timestamp: new Date().toISOString(),
    };
  });

  // POST /api/v1/alerts/register-device - Register or update mobile push device & sound preference
  fastify.post('/register-device', { schema: { body: registerDevice } }, async (request) => {
    const { pushDevices } = await import('../db/index.js');
    const body = request.body as any;

    const { token, platform = 'android', soundChoice = 'chime', enabled = true } = body;

    // Upsert device record
    const existing = await db
      .select()
      .from(pushDevices)
      .where(and(eq(pushDevices.token, token), eq(pushDevices.userId, userId(request))));

    let result;
    if (existing.length > 0) {
      const updated = await db
        .update(pushDevices)
        .set({
          platform,
          soundChoice,
          enabled: Boolean(enabled),
          updatedAt: new Date(),
        })
        .where(eq(pushDevices.token, token))
        .returning();
      result = updated[0];
    } else {
      const inserted = await db
        .insert(pushDevices)
        .values({
          id: crypto.randomUUID(),
          userId: userId(request),
          token,
          platform,
          soundChoice,
          enabled: Boolean(enabled),
          updatedAt: new Date(),
        })
        .returning();
      result = inserted[0];
    }

    return {
      success: true,
      message: 'Mobile push device registered successfully',
      data: result,
    };
  });

  // GET /api/v1/alerts/device-settings - Get latest device push & sound settings
  fastify.get('/device-settings', async (request) => {
    const { pushDevices } = await import('../db/index.js');
    const devices = await db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId(request)))
      .orderBy(desc(pushDevices.updatedAt))
      .limit(1);

    return {
      success: true,
      data: devices[0] || {
        enabled: true,
        soundChoice: 'chime',
        platform: 'android',
      },
    };
  });
};


