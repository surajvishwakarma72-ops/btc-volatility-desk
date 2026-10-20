import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { calRoutes } from './cal.js';

describe('GET /api/cal', () => {
  it('rejects a bad week param', async () => {
    const app = Fastify();
    await app.register(calRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/cal?week=lastyear' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
