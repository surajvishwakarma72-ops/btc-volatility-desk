import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));
vi.mock('../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) {
        const res = await h.db.exec(text);
        const last = res[res.length - 1];
        return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 };
      }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));

const { algoRoutes } = await import('./algo.js');
const { ensureAlgoSchema } = await import('../services/algo/algo-store.js');

const USER_ID = '11111111-1111-1111-1111-111111111111';

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (req: any, reply: any) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }
  });
  await app.register(algoRoutes, { prefix: '/algo' });
  return app;
}

const authHeader = (app: any, sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: 'trader' })}` });

describe('Algo Strategy Description API', () => {
  let app: any;

  beforeAll(async () => {
    h.db = new PGlite() as never;
    await ensureAlgoSchema();
    app = await build();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /algo/description requires login', async () => {
    const res = await app.inject({ method: 'GET', url: '/algo/description' });
    expect(res.statusCode).toBe(401);
  });

  it('PUT /algo/description saves plain-language strategy logic and GET retrieves it', async () => {
    const body = {
      entryConditions: 'Enter 0DTE/1DTE short strangle when ATM IV is above 20D HV and VRP > 2 pts.',
      holdConditions: 'Hold through European session unless underlying moves > 1.5x expected move.',
      exitConditions: 'Take profit at 50% max profit. Hard stop at 2x premium collected.',
      riskManagement: 'Max 100 lots per leg. Max portfolio delta exposure +-0.25 BTC.',
      sessionTimingRules: 'Enter between 13:00 and 15:00 IST. Do not enter on US CPI / FOMC release days.',
      marketConditionsNotes: 'Avoid entering during high macro volatility spikes or liquidity black holes.',
    };

    const putRes = await app.inject({
      method: 'PUT',
      url: '/algo/description',
      headers: authHeader(app, USER_ID),
      payload: body,
    });
    expect(putRes.statusCode).toBe(200);
    const putJson = putRes.json();
    expect(putJson.success).toBe(true);
    expect(putJson.description.entryConditions).toContain('short strangle');
    expect(putJson.description.riskManagement).toContain('Max 100 lots');

    const getRes = await app.inject({
      method: 'GET',
      url: '/algo/description',
      headers: authHeader(app, USER_ID),
    });
    expect(getRes.statusCode).toBe(200);
    const getJson = getRes.json();
    expect(getJson.success).toBe(true);
    expect(getJson.description.entryConditions).toBe(body.entryConditions);
    expect(getJson.description.exitConditions).toBe(body.exitConditions);
    expect(getJson.description.sessionTimingRules).toBe(body.sessionTimingRules);
  });
});
