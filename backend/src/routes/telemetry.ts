import type { FastifyPluginAsync } from 'fastify';
import { db, sessionAuditLogs, recalibrationAudits } from '../db/index.js';
import { desc, eq } from 'drizzle-orm';
import {
  PROVEN_BOUNDARIES,
  DEFAULT_USER_ID,
  recordSessionTelemetry,
  runAutomatedRecalibration,
  evaluateLockedRule,
} from '../services/self-testing-audit.js';
import { telemetrySession, telemetryCheckQuery } from '../schemas.js';

export const telemetryRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/telemetry/boundaries - Single shared source of truth for boundaries
  fastify.get('/boundaries', async () => {
    return {
      success: true,
      data: PROVEN_BOUNDARIES,
    };
  });

  // GET /api/v1/telemetry/audit - Return recent session telemetry and verification stats
  fastify.get('/audit', async (request) => {
    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };

    const logs = await db
      .select()
      .from(sessionAuditLogs)
      .where(eq(sessionAuditLogs.userId, DEFAULT_USER_ID))
      .orderBy(desc(sessionAuditLogs.sessionDate), desc(sessionAuditLogs.createdAt))
      .limit(Number(limit))
      .offset(Number(offset));

    const totalLogs = await db
      .select()
      .from(sessionAuditLogs)
      .where(eq(sessionAuditLogs.userId, DEFAULT_USER_ID));

    const matches = totalLogs.filter((l) => l.telemetryMatch).length;
    const mismatches = totalLogs.filter((l) => !l.telemetryMatch).length;
    const matchRate = totalLogs.length ? (matches / totalLogs.length) * 100 : 100;

    const latestRecalibration = await db
      .select()
      .from(recalibrationAudits)
      .orderBy(desc(recalibrationAudits.runAt))
      .limit(1);

    return {
      success: true,
      data: {
        totalLogged: totalLogs.length,
        verifiedMatches: matches,
        flaggedMismatches: mismatches,
        matchRatePercent: Number(matchRate.toFixed(2)),
        recentSessions: logs,
        latestRecalibration: latestRecalibration[0] || null,
      },
    };
  });

  // POST /api/v1/telemetry/session - Log a live session and self-test verification
  fastify.post('/session', { schema: { body: telemetrySession } }, async (request, reply) => {
    try {
      const payload = request.body as any;
      if (!payload || !payload.sessionDate || !payload.uiState) {
        return reply.status(400).send({
          success: false,
          error: 'Missing required session telemetry fields (sessionDate, uiState)',
        });
      }

      const result = await recordSessionTelemetry(payload);
      return {
        success: true,
        telemetryMatch: result.telemetryMatch,
        mismatchReason: result.mismatchReason,
        data: result.log,
      };
    } catch (err: any) {
      request.log.error(err, 'Failed to record session telemetry');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Internal server error recording session telemetry',
      });
    }
  });

  // POST /api/v1/telemetry/recalibrate - Run scheduled/manual Bonferroni + OOS recalibration
  fastify.post('/recalibrate', async (request, reply) => {
    try {
      const result = await runAutomatedRecalibration();
      return {
        success: true,
        data: result,
      };
    } catch (err: any) {
      request.log.error(err, 'Failed to execute automated recalibration');
      return reply.status(500).send({
        success: false,
        error: err.message || 'Internal server error executing recalibration',
      });
    }
  });

  // GET /api/v1/telemetry/check - Instant check of what the rule expects right now
  fastify.get('/check', { schema: { querystring: telemetryCheckQuery } }, async (request) => {
    const { timeMs, speed } = request.query as { timeMs?: string; speed?: string };
    const t = timeMs ? Number(timeMs) : Date.now();
    const s = speed ? Number(speed) : 0.95;
    const rule = evaluateLockedRule(t, s);
    return {
      success: true,
      data: rule,
    };
  });
};
