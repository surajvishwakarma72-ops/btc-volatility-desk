import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { askRoutes } from './ask.js';

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async function (request: any, reply: any) {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
  });
  await app.register(askRoutes, { prefix: '/ask' });
  return app;
}

describe('ask routes', () => {
  it('require the desk login', async () => {
    const app = await build();
    expect((await app.inject({ method: 'POST', url: '/ask', payload: { question: 'help' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/ask/suggestions' })).statusCode).toBe(401);
    await app.close();
  });

  it('reject empty and oversized questions', async () => {
    const app = await build();
    const h = { authorization: `Bearer ${app.jwt.sign({ sub: 'test' })}` };
    expect((await app.inject({ method: 'POST', url: '/ask', headers: h, payload: { question: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/ask', headers: h, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/ask', headers: h, payload: { question: 'x'.repeat(301) } })).statusCode).toBe(400);
    await app.close();
  });

  it('answers help and rule questions without any database, and lists suggestions', async () => {
    const app = await build();
    const h = { authorization: `Bearer ${app.jwt.sign({ sub: 'test' })}` };
    const help = await app.inject({ method: 'POST', url: '/ask', headers: h, payload: { question: 'what can you do?' } });
    expect(help.statusCode).toBe(200);
    expect(help.json()).toMatchObject({ success: true, intent: 'help' });
    const rule = await app.inject({ method: 'POST', url: '/ask', headers: h, payload: { question: 'what is the calendar spread rule' } });
    expect(rule.json().text).toMatch(/backwardation/);
    const sg = await app.inject({ method: 'GET', url: '/ask/suggestions', headers: h });
    expect(sg.json().suggestions.length).toBeGreaterThan(5);
    await app.close();
  });

  it('a question about data that is not there degrades to a plain message, never a 500', async () => {
    const app = await build();
    const h = { authorization: `Bearer ${app.jwt.sign({ sub: 'test' })}` };
    const r = await app.inject({ method: 'POST', url: '/ask', headers: h, payload: { question: "today's pnl" } });
    expect(r.statusCode).toBe(200);
    expect(typeof r.json().text).toBe('string');
    await app.close();
  });
});
