import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { marketGatewayRoutes } from './mkt.js';

async function build() {
  const app = Fastify();
  await app.register(marketGatewayRoutes, { prefix: '/api/v1/mkt' });
  return app;
}

describe('GET /api/v1/mkt', () => {
  it('400s when u is missing', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/mkt' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it('403s a disallowed host', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/mkt?u=' + encodeURIComponent('https://evil.example.com/x') });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
