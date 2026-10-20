import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

describe('authenticate preHandler', () => {
  it('401s without a token, passes with a valid one', async () => {
    const app = Fastify();
    await app.register(jwt, { secret: 'test-secret' });
    app.decorate('authenticate', async (req: any, reply: any) => {
      try { await req.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
    });
    app.get('/guarded', { preHandler: (app as any).authenticate }, async () => ({ ok: true }));
    const noTok = await app.inject({ method: 'GET', url: '/guarded' });
    expect(noTok.statusCode).toBe(401);
    const token = app.jwt.sign({ sub: 'desk' });
    const withTok = await app.inject({ method: 'GET', url: '/guarded', headers: { authorization: `Bearer ${token}` } });
    expect(withTok.statusCode).toBe(200);
    await app.close();
  });
});
