import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { botRoutes } from './bot.js';

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async function (request: any, reply: any) {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
  });
  await app.register(botRoutes, { prefix: '/bot' });
  return app;
}

describe('bot routes', () => {
  it('every route requires the desk JWT', async () => {
    const app = await build();
    const routes: Array<[string, string]> = [
      ['GET', '/bot/status'],
      ['GET', '/bot/positions'],
      ['GET', '/bot/runs'],
      ['GET', '/bot/runs/00000000-0000-0000-0000-000000000000/timeline'],
      ['GET', '/bot/runs/00000000-0000-0000-0000-000000000000/explain'],
      ['GET', '/bot/at?time=10:00'],
      ['GET', '/bot/events'],
      ['GET', '/bot/analytics/summary'],
      ['GET', '/bot/analytics'],
      ['GET', '/bot/drops'],
      ['GET', '/bot/today'], ['GET', '/bot/pnl'],
      ['GET', '/bot/top'],
      ['GET', '/bot/learn'],
      ['POST', '/bot/learn/run'],
      ['POST', '/bot/learn/rollback'],
      ['POST', '/bot/pause'],
      ['POST', '/bot/resume'],
      ['POST', '/bot/kill'],
      ['POST', '/bot/kill/reset'],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET' | 'POST', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await app.close();
  });

  it('status reports a disabled engine without touching the database', async () => {
    const app = await build();
    const token = app.jwt.sign({ sub: 'test' });
    const res = await app.inject({ method: 'GET', url: '/bot/status', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, enabled: false, engine: 'stopped', mode: 'paper', waiting: [] });
    await app.close();
  });

  it('rejects malformed time, date and run id inputs with 400 before querying', async () => {
    const app = await build();
    const token = app.jwt.sign({ sub: 'test' });
    const h = { authorization: `Bearer ${token}` };
    for (const url of [
      '/bot/at?time=noon',
      '/bot/at?time=25:00',
      '/bot/at?time=10:00&date=yesterday',
      '/bot/runs/not-a-uuid/timeline',
      '/bot/runs/not-a-uuid/explain',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: h });
      expect(res.statusCode, url).toBe(400);
    }
    await app.close();
  });

  it('rollback only accepts a learned strategy', async () => {
    const app = await build();
    const token = app.jwt.sign({ sub: '00000000-0000-0000-0000-000000000001', role: 'admin' });
    const res = await app.inject({ method: 'POST', url: '/bot/learn/rollback', headers: { authorization: `Bearer ${token}` }, payload: { strategy: 'EVE_LONG' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('a friend (trader token) can watch the bot but cannot pause, kill or change it; the owner passes the guard', async () => {
    const app = await build();
    const friend = { authorization: `Bearer ${app.jwt.sign({ sub: '11111111-1111-1111-1111-111111111111', role: 'trader' })}` };
    for (const url of ['/bot/pause', '/bot/resume', '/bot/kill', '/bot/kill/reset', '/bot/learn/run', '/bot/learn/rollback']) {
      expect((await app.inject({ method: 'POST', url, headers: friend })).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: 'GET', url: '/bot/status', headers: friend })).statusCode).toBe(200); // read-only access stays
    const owner = { authorization: `Bearer ${app.jwt.sign({ sub: '00000000-0000-0000-0000-000000000001', role: 'trader' })}` };
    const r = await app.inject({ method: 'POST', url: '/bot/resume', headers: owner });
    expect([401, 403]).not.toContain(r.statusCode); // past the guard (the engine is off in tests, so the route itself answers)
    await app.close();
  });

  it('positions is refused while the bot is disabled', async () => {
    const app = await build();
    const token = app.jwt.sign({ sub: 'test' });
    const res = await app.inject({ method: 'GET', url: '/bot/positions', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
