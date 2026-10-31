import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { METRIC_CONFIG, PULSE_CONFIG, REGIME_GATE_CONFIG, SCORE_CONFIG } from '../lib/pulse/config.js';
import { cohortSlotMs, HOUR_MS, SLOTS, type Slot } from '../lib/pulse/grid.js';
import { termInverted } from '../lib/pulse/metrics/market.js';
import { metricSeries, winnerAtAge, type CohortRow } from '../lib/pulse/metrics/series.js';
import { breakevens, winnerPersistence } from '../lib/pulse/metrics/tape.js';
import { readings, type CohortSteps, type LiveContext } from '../lib/pulse/score/score.js';
import type { PulseCohort } from '../lib/pulse/snapshot.js';
import { pulseEngine } from '../services/pulse/pulse-engine.js';
import { regimeService } from '../services/pulse/regime-service.js';
import { cohortRows, latestMarketRows, pulseTablesExist, recentCohorts } from '../services/pulse/pulse-store.js';

/** A week of hourly cohorts: covers every open one (at most 24) and a long run of no_valid_strikes before the persistence window. */
const RECENT_COHORTS = 168;
const nextSlotMs = (nowMs: number) => cohortSlotMs(nowMs) + HOUR_MS;

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
   * P&L over time for one cohort of a slot (the open one with the newest entry, else the newest that traded).
   * call / put are the short legs' USD P&L per lot; fut is the better of the two hedge futures sides; net is call + put.
   */
  fastify.get('/series', auth, async (req, reply) => {
    const q = metricsQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ success: false, error: 'slot must be current, next or n2n' });
    const ready = await pulseTablesExist();
    const recent = ready ? await recentCohorts(q.data.slot, 48) : [];
    const traded = recent.filter((c) => c.status !== 'no_valid_strikes');
    const cohort = traded.find((c) => c.status === 'open') ?? traded[0];
    if (!cohort) return { success: true, slot: q.data.slot, cohort: null, points: [] };
    const rows = await cohortRows(cohort.id);
    const points = rows.filter((r) => r.data_ok).map((r) => {
      const call = r.call.net_pnl;
      const put = r.put.net_pnl;
      const fl = r.fut_long_pnl;
      const fs = r.fut_short_pnl;
      const fut = fl === null && fs === null ? null : Math.max(fl ?? -Infinity, fs ?? -Infinity);
      return { t: r.sampled_ms, call, put, fut, net: call === null || put === null ? null : call + put };
    });
    return {
      success: true,
      slot: q.data.slot,
      cohort: { id: cohort.id, status: cohort.status, opened_at: cohort.opened_at, call_strike: cohort.call_strike, put_strike: cohort.put_strike },
      points,
    };
  });

  /**
   * The Strangle Pulse panel in one call: verdict card, confidence line with zones, zone changes and the newest cohort's P&L lines.
   * Computed on read from stored cohorts; cached for 45 s per slot. Confidence is uncalibrated until Phase 7.
   */
  const scoreCache = new Map<Slot, { at: number; body: unknown }>();
  fastify.get('/score', auth, async (req, reply) => {
    const q = metricsQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ success: false, error: 'slot must be current, next or n2n' });
    const { slot } = q.data;
    const hit = scoreCache.get(slot);
    if (hit && Date.now() - hit.at < 45_000) return hit.body;

    const ready = await pulseTablesExist();
    const recent = ready ? await recentCohorts(slot, SCORE_CONFIG.historyHours + 12) : [];
    const traded = recent.filter((c) => c.status !== 'no_valid_strikes');
    const rowsBy = new Map<string, CohortRow[]>(await Promise.all(traded.map(async (c) => [c.id, await cohortRows(c.id)] as const)));
    const cohorts: CohortSteps[] = traded.map((c) => ({ opened_at: c.opened_at, steps: metricSeries(c, rowsBy.get(c.id) ?? []) }));

    const nowMs = Date.now();
    const grids = [...new Set(cohorts.flatMap((c) => c.steps.map((s) => s.grid_ms)))]
      .filter((g) => g >= nowMs - SCORE_CONFIG.historyHours * 3_600_000).sort((a, b) => a - b);

    const gate = regimeService.snapshot();
    const market = ready ? await latestMarketRows() : [];
    const fresh = market.length > 0 && nowMs - market[0].grid_ms <= METRIC_CONFIG.marketStaleMs;
    const atm = (s: Slot) => market.find((m) => m.slot === s)?.atm_iv ?? null;
    const scoredRecent = traded.slice(0, METRIC_CONFIG.persistenceWindow);
    const winners = scoredRecent.flatMap((c) => { const j = winnerAtAge(c, rowsBy.get(c.id) ?? []); return j === null ? [] : [j.side]; });
    const live: LiveContext = {
      gatePass: gate.pass,
      killer: gate.inputs.find((i) => i.id === 'killer')?.ok === false ? true : null,
      termInverted: fresh ? termInverted(atm('current'), atm('next')) : null,
      persistence: winnerPersistence(winners),
      noValidStrikes: recent[0]?.status === 'no_valid_strikes',
    };
    const list = readings(grids, cohorts, live);
    const last = list.at(-1) ?? null;

    const changes = list.flatMap((r, i) => (i > 0 && r.zone !== list[i - 1].zone ? [{ t: r.t, zone: r.zone, reason: r.why[0] ?? null }] : []));
    const open = traded.find((c) => c.status === 'open') ?? traded[0] ?? null;
    const credit = open && open.call_bid !== null && open.put_bid !== null ? open.call_bid + open.put_bid : null;
    const pnl = open
      ? (rowsBy.get(open.id) ?? []).filter((r) => r.data_ok).map((r) => {
          const fl = r.fut_long_pnl; const fs = r.fut_short_pnl;
          return { t: r.sampled_ms, call: r.call.net_pnl, put: r.put.net_pnl, fut: fl === null && fs === null ? null : Math.max(fl ?? -Infinity, fs ?? -Infinity), net: r.call.net_pnl === null || r.put.net_pnl === null ? null : r.call.net_pnl + r.put.net_pnl };
        })
      : [];
    const body = {
      success: true,
      slot,
      uncalibrated: true,
      card: last && {
        verdict: last.verdict, zone: last.zone, confidence: last.confidence, why: last.why, flips: last.flips, vetoes: last.vetoes, heavyLeg: last.heavyLeg,
        gate: { pass: gate.pass, reasons: gate.reasons },
        nextCohortMs: nextSlotMs(nowMs),
        strikes: open && { call: open.call_strike, put: open.put_strike, callDelta: open.call_delta, putDelta: open.put_delta },
        premium: open && { credit, breakevens: breakevens(open.call_strike, open.put_strike, credit) },
        stopPremium: open && { call: open.call_bid === null ? null : open.call_bid * PULSE_CONFIG.stopMultiple, put: open.put_bid === null ? null : open.put_bid * PULSE_CONFIG.stopMultiple },
      },
      zones: { sellMin: SCORE_CONFIG.zones.sellMin, cautionMin: SCORE_CONFIG.zones.cautionMin },
      points: list.map((r) => ({ t: r.t, c: r.confidence, z: r.zone })),
      changes,
      pnl,
      cohort: open && { id: open.id, status: open.status, opened_at: open.opened_at },
    };
    scoreCache.set(slot, { at: Date.now(), body });
    return body;
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
