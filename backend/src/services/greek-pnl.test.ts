import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import { computeGreekPnl, type PositionInput } from './greek-pnl.js';
import { pnlRoutes } from '../routes/pnl.js';

describe('Greek P&L Attribution (Task T2.3)', () => {
  // ─── Unit Tests for computeGreekPnl() ────────────────────────────────────

  it('a. known input produces exact expected output across all 5 components', () => {
    const input: PositionInput = {
      symbol: 'BTC-27DEC24-100000-C',
      quantity: 10,
      contract_value: 0.001,
      delta: 0.5,
      gamma: 0.00002,
      theta: -20,
      vega: 15,
      delta_spot: 1000,
      delta_vol: 0.02,
      elapsed_seconds: 43200,
      total_pnl: 40,
    };

    const res = computeGreekPnl(input);

    expect(res.symbol).toBe('BTC-27DEC24-100000-C');
    // delta_pnl = 10 * 0.001 * 0.5 * 1000 = 5.0
    expect(res.delta_pnl).toBeCloseTo(5.0, 5);
    // gamma_pnl = 0.5 * 10 * 0.001 * 0.00002 * (1000^2) = 0.1
    expect(res.gamma_pnl).toBeCloseTo(0.1, 5);
    // theta_pnl = -20 * (43200 / 86400) = -10.0
    expect(res.theta_pnl).toBeCloseTo(-10.0, 5);
    // vega_pnl = 15 * 0.02 * 100 = 30.0
    expect(res.vega_pnl).toBeCloseTo(30.0, 5);
    // other_pnl = 40 - 5.0 - 0.1 - (-10.0) - 30.0 = 14.9
    expect(res.other_pnl).toBeCloseTo(14.9, 5);
    expect(res.total_pnl).toBe(40);
  });

  it('b. short position (negative quantity) produces negative delta_pnl when spot rises', () => {
    const shortInput: PositionInput = {
      symbol: 'BTC-27DEC24-95000-C',
      quantity: -10, // short
      contract_value: 0.001,
      delta: 0.4,
      gamma: 0.00001,
      theta: 15,
      vega: -10,
      delta_spot: 1500, // spot rises
      delta_vol: 0.01,
      elapsed_seconds: 3600,
      total_pnl: -20,
    };

    const res = computeGreekPnl(shortInput);

    // delta_pnl = -10 * 0.001 * 0.4 * 1500 = -6.0
    expect(res.delta_pnl).toBeLessThan(0);
    expect(res.delta_pnl).toBeCloseTo(-6.0, 5);
  });

  it('c. other_pnl = total_pnl - sum of greek components (within 0.01 tolerance)', () => {
    const testCases: PositionInput[] = [
      {
        quantity: 25,
        contract_value: 0.001,
        delta: -0.3,
        gamma: 0.00005,
        theta: -15.5,
        vega: 8.2,
        delta_spot: -1250,
        delta_vol: -0.035,
        elapsed_seconds: 7200,
        total_pnl: 12.34,
      },
      {
        quantity: -100,
        contract_value: 0.001,
        delta: 0.15,
        gamma: 0.000012,
        theta: 45.2,
        vega: -12.4,
        delta_spot: 3400,
        delta_vol: 0.012,
        elapsed_seconds: 86400,
        total_pnl: -55.8,
      },
    ];

    for (const tc of testCases) {
      const res = computeGreekPnl(tc);
      const sumGreeks = res.delta_pnl + res.gamma_pnl + res.theta_pnl + res.vega_pnl;
      expect(Math.abs(res.other_pnl - (res.total_pnl - sumGreeks))).toBeLessThan(0.01);

      const sumAll = res.delta_pnl + res.gamma_pnl + res.theta_pnl + res.vega_pnl + res.other_pnl;
      expect(Math.abs(sumAll - res.total_pnl)).toBeLessThan(0.01);
    }
  });

  it('d. zero elapsed_seconds produces theta_pnl = 0', () => {
    const zeroTimeInput: PositionInput = {
      quantity: 10,
      contract_value: 0.001,
      delta: 0.5,
      gamma: 0.00001,
      theta: -50,
      vega: 20,
      delta_spot: 100,
      delta_vol: 0.01,
      elapsed_seconds: 0,
      total_pnl: 5,
    };

    const res = computeGreekPnl(zeroTimeInput);
    expect(res.theta_pnl).toBe(0);
  });

  // ─── Route Tests for GET /api/v1/pnl/greek ───────────────────────────────

  describe('Route GET /api/v1/pnl/greek', () => {
    let app: FastifyInstance;
    let token: string;
    const USER_ID = '00000000-0000-0000-0000-000000000001';

    beforeAll(async () => {
      app = fastify({ logger: false });
      await app.register(jwt, { secret: 'pnl-test-secret' });
      await app.register(pnlRoutes, { prefix: '/api/v1/pnl' });
      token = app.jwt.sign({ sub: USER_ID, role: 'admin', email: 'desk@local' });
    });

    afterAll(async () => {
      await app.close();
    });

    it('e. unauthenticated request returns 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/pnl/greek?symbol=BTC-27DEC24-100000-C',
      });
      expect(res.statusCode).toBe(401);
    });

    it('f. request without symbol returns 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/pnl/greek',
        headers: { Cookie: `desk_token=${token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/symbol/i);
    });

    it('g. authenticated request returns Greek P&L breakdown', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/pnl/greek?symbol=BTC-27DEC24-100000-C&quantity=10&contract_value=0.001&delta=0.5&gamma=0.00002&theta=-20&vega=15&delta_spot=1000&delta_vol=0.02&elapsed_seconds=43200&total_pnl=40',
        headers: { Cookie: `desk_token=${token}` },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.symbol).toBe('BTC-27DEC24-100000-C');
      expect(data.delta_pnl).toBeCloseTo(5.0, 5);
      expect(data.gamma_pnl).toBeCloseTo(0.1, 5);
      expect(data.theta_pnl).toBeCloseTo(-10.0, 5);
      expect(data.vega_pnl).toBeCloseTo(30.0, 5);
      expect(data.other_pnl).toBeCloseTo(14.9, 5);
      expect(data.total_pnl).toBe(40);
    });
  });
});

