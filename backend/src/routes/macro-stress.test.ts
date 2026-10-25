import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { macroStressRoutes } from './macro-stress.js';
import { macroStressWorker, DEFAULT_STRESS_WEIGHTS } from '../services/macro-stress-worker.js';

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async function (request: any, reply: any) {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
  });
  await app.register(macroStressRoutes, { prefix: '/api/v1/macro' });
  return app;
}

describe('Macro Stress API (/api/v1/macro/stress)', () => {
  it('returns valid 0-100 stress score and components, and says plainly that nothing has been measured yet', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/macro/stress' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.score).toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    expect(['calm', 'elevated', 'shock']).toContain(body.zone);
    expect(['RISK-OFF', 'RISK-ON']).toContain(body.direction);
    expect(body.matrix).toBeInstanceOf(Array);
    expect(body.matrix.length).toBe(5);
    expect(body.curve).toBeInstanceOf(Array);
    expect(body.tradeRule).toBeDefined();
    // before any poll the numbers are a placeholder and the snapshot admits it
    expect(body.hasData).toBe(false);
    expect(body.status).toBe('degraded');
    expect(body.note).toMatch(/placeholder/);
    expect(body.matrix.every((m: any) => m.shock === 'loading')).toBe(true);
    // no invented history: only the "now" point and the three projected ones
    expect(body.curve.filter((p: any) => !p.isNow && !p.isProj)).toHaveLength(0);
    await app.close();
  });

  it('changing weights needs the desk login', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/v1/macro/weights', payload: { forex: 0.9 } });
    expect(res.statusCode).toBe(401);
    expect(macroStressWorker.weights.forex).toBe(DEFAULT_STRESS_WEIGHTS.forex);
    await app.close();
  });

  it('updates weights with a login, and refuses nonsense', async () => {
    const app = await build();
    const h = { authorization: `Bearer ${app.jwt.sign({ sub: 't' })}` };
    const ok = await app.inject({ method: 'POST', url: '/api/v1/macro/weights', headers: h, payload: { forex: 0.20, event: 0.25 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().weights.forex).toBe(0.20);
    expect(ok.json().weights.event).toBe(0.25);
    for (const payload of [{ forex: 'big' }, { forex: -1 }, { forex: 99 }, { nonsense: 1 }]) {
      const bad = await app.inject({ method: 'POST', url: '/api/v1/macro/weights', headers: h, payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    macroStressWorker.setWeights(DEFAULT_STRESS_WEIGHTS);
    await app.close();
  });
});
