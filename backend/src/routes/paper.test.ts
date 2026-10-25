import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { orderBody, paperRoutes } from './paper.js';

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async function (request: any, reply: any) {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
  });
  await app.register(paperRoutes, { prefix: '/paper' });
  return app;
}

describe('paper routes', () => {
  it('every route requires the desk login', async () => {
    const app = await build();
    const routes: Array<[string, string]> = [
      ['GET', '/paper/account'], ['GET', '/paper/board'], ['GET', '/paper/book?symbol=BTCUSD'], ['POST', '/paper/preview'], ['POST', '/paper/orders'],
      ['DELETE', '/paper/orders/00000000-0000-0000-0000-000000000000'], ['POST', '/paper/orders/cancel-all'], ['GET', '/paper/orders'], ['GET', '/paper/fills'],
      ['POST', '/paper/leverage'], ['POST', '/paper/reset'], ['POST', '/paper/strategy'], ['POST', '/paper/strategy/preview'], ['POST', '/paper/margin-mode'], ['GET', '/paper/flow'],
    ];
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as 'GET', url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    await app.close();
  });

  it('rejects malformed orders and resets before touching anything', async () => {
    const app = await build();
    const h = { authorization: `Bearer ${app.jwt.sign({ sub: 't' })}` };
    for (const payload of [{}, { symbol: 'BTCUSD', side: 'hold', type: 'market', lots: 1 }, { symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 0 }, { symbol: 'BTC USD;', side: 'buy', type: 'market', lots: 1 }, { symbol: 'BTCUSD', side: 'buy', type: 'limit', lots: 1.5 }]) {
      const res = await app.inject({ method: 'POST', url: '/paper/orders', headers: h, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/paper/reset', headers: h, payload: { balance: 5000 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/paper/reset', headers: h, payload: { balance: 50, confirm: 'RESET' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/paper/orders/not-a-uuid', headers: h })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/paper/book', headers: h })).statusCode).toBe(400);
    await app.close();
  });

  it('rejects malformed strategies and margin modes before touching anything', async () => {
    const app = await build();
    const h = { authorization: `Bearer ${app.jwt.sign({ sub: 't' })}` };
    for (const payload of [{}, { legs: [] }, { legs: Array.from({ length: 9 }, () => ({ symbol: 'C-BTC-80000-271026', side: 'buy', lots: 1 })) }, { legs: [{ symbol: 'C-BTC-80000-271026', side: 'hold', lots: 1 }] }, { legs: [{ symbol: 'C-BTC-80000-271026', side: 'buy', lots: 0 }] }]) {
      expect((await app.inject({ method: 'POST', url: '/paper/strategy', headers: h, payload })).statusCode, JSON.stringify(payload)).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/paper/strategy/preview', headers: h, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/paper/margin-mode', headers: h, payload: { mode: 'isolated' } })).statusCode).toBe(400);
    await app.close();
  });

  it('the order schema accepts a full bracket order', () => {
    expect(orderBody.safeParse({ symbol: 'BTCUSD', side: 'buy', type: 'limit', lots: 10, price: 80000, leverage: 10, reduceOnly: false, takeProfit: 82000, stopLoss: 79000 }).success).toBe(true);
  });
});
