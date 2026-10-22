import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { macroStressRoutes } from './macro-stress.js';

async function build() {
  const app = Fastify();
  await app.register(macroStressRoutes, { prefix: '/api/v1/macro' });
  return app;
}

describe('Macro Stress API (/api/v1/macro/stress)', () => {
  it('returns valid 0-100 stress score and components', async () => {
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
    await app.close();
  });

  it('updates weights via POST /api/v1/macro/weights', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/macro/weights',
      payload: { forex: 0.20, event: 0.25 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.weights.forex).toBe(0.20);
    expect(body.weights.event).toBe(0.25);
    await app.close();
  });
});
