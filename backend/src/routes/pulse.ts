import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { METRIC_CONFIG, PULSE_CONFIG, REGIME_GATE_CONFIG, SCORE_CONFIG } from '../lib/pulse/config.js';
import { cohortSlotMs, HOUR_MS, SLOTS, type Slot } from '../lib/pulse/grid.js';
import { termInverted } from '../lib/pulse/metrics/market.js';
import { pulseMomentum } from '../lib/pulse/metrics/momentum.js';
import { metricSeries, winnerAtAge, type CohortRow } from '../lib/pulse/metrics/series.js';
import { breakevens, winnerPersistence } from '../lib/pulse/metrics/tape.js';
import { linesAt, readings, type CohortSteps, type LiveContext } from '../lib/pulse/score/score.js';
import type { PulseCohort } from '../lib/pulse/snapshot.js';
import { pulseEngine } from '../services/pulse/pulse-engine.js';
import { pulseScore } from '../services/pulse/pulse-score.js';
import { regimeService } from '../services/pulse/regime-service.js';
import { cohortRows, cohortRowsMany, latestMarketRows, pulseTablesExist, recentCohorts } from '../services/pulse/pulse-store.js';

/** A week of hourly cohorts: covers every open one (at most 24) and a long run of no_valid_strikes before the persistence window. */
const RECENT_COHORTS = 168;

const metricsQuery = z.object({ slot: z.enum(SLOTS as [Slot, ...Slot[]]) });

/** Read-only Strangle Pulse views. Each needs the desk JWT. */
export const pulseRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };

  fastify.get('/status', auth, async () => ({ success: true, ...pulseEngine.status() }));

  fastify.get('/regime', auth, async () => {
    const g = REGIME_GATE_CONFIG;
    return {
      success: true,
      enabled: process.env.PULSE_ENABLED === 'true',
      ...regimeService.snapshot(),
      gate: { id: g.gateId, ivRvMin: g.ivRvMin, adxMax: g.adxMax, dvolMax: g.dvolMax, ivScaleK: g.ivScaleK, rvHours: g.rvHours },
      note: 'Uses completed hourly bars only; the desk screen also counts the forming bar, so values can differ slightly.',
    };
  });

  /**
   * The Strangle Pulse panel in one call: verdict card, confidence line with zones, zone changes and the newest cohort's P&L lines.
   * Computed on read from stored cohorts; cached for 45 s per slot. Confidence is uncalibrated until Phase 7.
   */
  fastify.get('/score', auth, async (req, reply) => {
    const q = metricsQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ success: false, error: 'slot must be current, next or n2n' });
    return pulseScore(q.data.slot);
  });

  fastify.get('/metrics', auth, async (req, reply) => {
    const q = metricsQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ success: false, error: 'slot must be current, next or n2n' });
    const { slot } = q.data;

    const ready = await pulseTablesExist();
    const recent = ready ? await recentCohorts(slot, RECENT_COHORTS) : [];
    const market = ready ? await latestMarketRows() : [];

    const open = recent.filter((c) => c.status === 'open');
    const scored = recent.filter((c) => c.status !== 'no_valid_strikes').slice(0, METRIC_CONFIG.persistenceWindow);
    const wanted = new Map<string, PulseCohort>([...open, ...scored].map((c) => [c.id, c]));
    const rows = new Map<string, CohortRow[]>(await Promise.all([...wanted.keys()].map(async (id) => [id, await cohortRows(id)] as const)));

    // Each cohort is judged at the same age; one that has not reached it (young, or closed first) is left out of n.
    const winners = scored.flatMap((c) => {
      const judged = winnerAtAge(c, rows.get(c.id) ?? []);
      return judged === null ? [] : [judged.side];
    });

    // latestMarketRows are all from one grid.
    const marketAt = market.length === 0 ? null : {
      grid_ms: market[0].grid_ms,
      sampled_ms: Math.max(...market.map((m) => m.sampled_ms)),
      stale: Date.now() - market[0].grid_ms > METRIC_CONFIG.marketStaleMs,
    };
    const fresh = marketAt !== null && !marketAt.stale;
    const atm = (s: Slot) => market.find((m) => m.slot === s)?.atm_iv ?? null;
    const here = market.find((m) => m.slot === slot);

    return {
      success: true,
      slot,
      cohorts: open.map((c) => ({ id: c.id, slot_ms: c.slot_ms, latest: metricSeries(c, rows.get(c.id) ?? []).at(-1) ?? null })),
      persistence: winnerPersistence(winners),
      skew: fresh ? { rr25: here?.rr25 ?? null, atm_iv: here?.atm_iv ?? null } : null,
      term_inverted: fresh ? termInverted(atm('current'), atm('next')) : null,
      market: marketAt,
      gex: { available: false },
    };
  });
};
