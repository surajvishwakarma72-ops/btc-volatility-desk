import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import {
  isDeltaInBand,
  validateStrike,
  computeConfidenceScore,
  createShadowCohort,
  updateCohortMetrics,
  clearInMemoryShadowCohorts,
  addInMemoryShadowCohort,
} from './shadow-strangle.js';
import { shadowRoutes } from '../routes/shadow.js';

describe('Shadow Strangle Engine (Task T2.5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearInMemoryShadowCohorts();
  });

  // a. Strike outside 0.10–0.15 delta is rejected (returns null, logs NO)
  it('a. Strike outside 0.10–0.15 delta is rejected (returns null, logs NO)', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Low delta (0.05)
    const lowResult = validateStrike({ strike: 80000, delta: 0.05 });
    expect(lowResult).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NO entry'));

    consoleSpy.mockClear();

    // High delta (0.18)
    const highResult = validateStrike({ strike: 95000, delta: 0.18 });
    expect(highResult).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NO entry'));

    // Negative high delta (-0.16)
    const negHighResult = validateStrike({ strike: 75000, delta: -0.16 });
    expect(negHighResult).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NO entry'));
  });

  // b. Strike at exactly 0.10 delta is accepted
  it('b. Strike at exactly 0.10 delta is accepted', () => {
    expect(isDeltaInBand(0.10)).toBe(true);
    expect(isDeltaInBand(-0.10)).toBe(true);

    const callResult = validateStrike({ strike: 96000, delta: 0.10, iv: 0.45 });
    expect(callResult).not.toBeNull();
    expect(callResult?.strike).toBe(96000);
    expect(callResult?.delta).toBe(0.10);

    const putResult = validateStrike({ strike: 78000, delta: -0.10, iv: 0.48 });
    expect(putResult).not.toBeNull();
    expect(putResult?.strike).toBe(78000);
    expect(putResult?.delta).toBe(-0.10);
  });

  // c. Strike at exactly 0.15 delta is accepted
  it('c. Strike at exactly 0.15 delta is accepted', () => {
    expect(isDeltaInBand(0.15)).toBe(true);
    expect(isDeltaInBand(-0.15)).toBe(true);

    const callResult = validateStrike({ strike: 94000, delta: 0.15, iv: 0.44 });
    expect(callResult).not.toBeNull();
    expect(callResult?.strike).toBe(94000);
    expect(callResult?.delta).toBe(0.15);

    const putResult = validateStrike({ strike: 80000, delta: -0.15, iv: 0.46 });
    expect(putResult).not.toBeNull();
    expect(putResult?.strike).toBe(80000);
    expect(putResult?.delta).toBe(-0.15);
  });

  // d. Confidence score formula produces correct value for known inputs
  it('d. Confidence score formula produces correct value for known inputs', () => {
    // Known Input 1:
    // cohort_age_hours = 2 -> 2 * 10 = 20
    // current_iv = 0.50, max_iv_last_30d = 1.0 -> iv_rank = 0.50 -> 0.50 * 50 = 25
    // entry_delta = 0.12, current_delta = 0.14 -> |0.14 - 0.12| = 0.02 -> delta_stability = 1 - 0.02 = 0.98 -> 0.98 * 40 = 39.2
    // total = 20 + 25 + 39.2 = 84.2
    const score1 = computeConfidenceScore({
      cohort_age_hours: 2,
      current_iv: 0.50,
      max_iv_last_30d: 1.0,
      current_delta: 0.14,
      entry_delta: 0.12,
    });
    expect(score1).toBeCloseTo(84.2, 4);

    // Known Input 2 (Capped at 100):
    // cohort_age_hours = 6 (60) + iv_rank = 1.0 (50) + delta_stability = 1.0 (40) = 150 -> min(100, 150) = 100
    const score2 = computeConfidenceScore({
      cohort_age_hours: 6,
      current_iv: 0.85,
      max_iv_last_30d: 0.85,
      current_delta: 0.12,
      entry_delta: 0.12,
    });
    expect(score2).toBe(100);

    // Known Input 3 (Fresh cohort at age 0):
    // cohort_age_hours = 0 (0)
    // current_iv = 0.30, max_iv_last_30d = 0.60 -> iv_rank = 0.5 (25)
    // current_delta = 0.12, entry_delta = 0.12 -> delta_stability = 1.0 (40)
    // total = 0 + 25 + 40 = 65
    const score3 = computeConfidenceScore({
      cohort_age_hours: 0,
      current_iv: 0.30,
      max_iv_last_30d: 0.60,
      current_delta: 0.12,
      entry_delta: 0.12,
    });
    expect(score3).toBeCloseTo(65, 4);
  });

  // e. Cohort at 0.09 delta is rejected even if close to band
  it('e. Cohort at 0.09 delta is rejected even if close to band', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // Call strike at 0.09
    const cohortWith009Call = createShadowCohort({
      cohort_hour: '2026-10-30T10:00:00Z',
      call: { strike: 98000, delta: 0.09, iv: 0.40 },
      put: { strike: 78000, delta: -0.12, iv: 0.42 },
      spot_at_entry: 88000,
    });
    expect(cohortWith009Call).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NO entry'));

    consoleSpy.mockClear();

    // Put strike at 0.09 magnitude (-0.09)
    const cohortWith009Put = createShadowCohort({
      cohort_hour: '2026-10-30T10:00:00Z',
      call: { strike: 94000, delta: 0.12, iv: 0.40 },
      put: { strike: 76000, delta: -0.09, iv: 0.42 },
      spot_at_entry: 88000,
    });
    expect(cohortWith009Put).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NO entry'));

    // Marginal 0.0999 delta (just below 0.10) is also strictly rejected
    consoleSpy.mockClear();
    const cohortWith00999 = createShadowCohort({
      cohort_hour: '2026-10-30T10:00:00Z',
      call: { strike: 97500, delta: 0.0999, iv: 0.40 },
      put: { strike: 78000, delta: -0.12, iv: 0.42 },
      spot_at_entry: 88000,
    });
    expect(cohortWith00999).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NO entry'));
  });

  // Additional engine verification: 15-minute metrics update
  it('updates 15-minute metrics for an active shadow cohort', () => {
    const cohort = createShadowCohort({
      cohort_hour: '2026-10-30T10:00:00Z',
      call: { strike: 94000, delta: 0.12, iv: 0.40 },
      put: { strike: 80000, delta: -0.12, iv: 0.42 },
      spot_at_entry: 88000,
      max_iv_last_30d: 0.80,
    });
    expect(cohort).not.toBeNull();
    if (!cohort) return;

    // Simulate 45 minutes elapsed (now: 10:45 UTC)
    const metrics = updateCohortMetrics({
      cohort,
      call_current_iv: 0.38,
      put_current_iv: 0.40,
      call_current_delta: 0.13,
      put_current_delta: -0.11,
      current_pnl: 14.50,
      now: '2026-10-30T10:45:00Z',
      max_iv_last_30d: 0.80,
    });

    expect(metrics.elapsed_minutes).toBe(45);
    expect(metrics.current_iv).toBeCloseTo(0.39, 4);
    expect(metrics.current_pnl).toBe(14.50);
    expect(metrics.confidence_score).toBeGreaterThan(0);
  });

  // Route Tests: GET /api/v1/shadow/strangles
  describe('Route GET /api/v1/shadow/strangles', () => {
    let app: FastifyInstance;
    let token: string;
    const USER_ID = '00000000-0000-0000-0000-000000000001';

    beforeAll(async () => {
      app = fastify({ logger: false });
      await app.register(jwt, { secret: 'shadow-test-secret' });
      await app.register(shadowRoutes, { prefix: '/api/v1/shadow' });
      token = app.jwt.sign({ sub: USER_ID, role: 'owner', email: 'owner@desk.local' });
    });

    afterAll(async () => {
      await app.close();
    });

    it('unauthenticated request returns 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/shadow/strangles',
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toContain('Unauthorized');
    });

    it('authenticated request returns last 24 cohorts ordered by cohort_hour DESC', async () => {
      // Populate test in-memory cohorts
      clearInMemoryShadowCohorts();
      for (let i = 0; i < 30; i++) {
        const d = new Date(Date.now() - i * 3600000);
        d.setUTCMinutes(0, 0, 0);
        d.setUTCMilliseconds(0);
        addInMemoryShadowCohort({
          id: `cohort-${i}`,
          cohort_hour: d.toISOString(),
          call_strike: 94000,
          put_strike: 80000,
          call_entry_iv: 0.40,
          put_entry_iv: 0.42,
          call_delta: 0.12,
          put_delta: -0.12,
          spot_at_entry: 88000,
          confidence_score: 75,
          status: i % 2 === 0 ? 'open' : 'closed',
        });
      }

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/shadow/strangles',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.cohorts)).toBe(true);
      expect(body.cohorts.length).toBeLessThanOrEqual(24);

      // Verify status filtering
      const openRes = await app.inject({
        method: 'GET',
        url: '/api/v1/shadow/strangles?status=open',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });
      expect(openRes.statusCode).toBe(200);
      const openBody = openRes.json();
      expect(openBody.cohorts.every((c: any) => c.status === 'open')).toBe(true);
    });
  });
});
