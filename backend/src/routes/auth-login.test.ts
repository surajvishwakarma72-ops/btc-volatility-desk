import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { authRoutes } from './auth.js';

beforeAll(() => { process.env.DESK_PASSWORD = 'correct-horse'; });

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (req: any, reply: any) => { try { await req.jwtVerify(); } catch { reply.status(401).send({}); } });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  return app;
}

describe('POST /api/v1/auth/login', () => {
  it('rejects a wrong password with 401', async () => {
    const app = await build();
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'nope' } });
    expect(r.statusCode).toBe(401);
    await app.close();
  });
  it('returns a JWT for the correct password', async () => {
    const app = await build();
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { password: 'correct-horse' } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).token).toBeTruthy();
    await app.close();
  });
});
