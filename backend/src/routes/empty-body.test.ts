import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

/** The same JSON parser the server installs: an empty body with a JSON content type is empty, bad JSON is still a 400. */
const parser = (_req: unknown, body: unknown, done: (e: Error | null, v?: unknown) => void) => {
  const text = typeof body === 'string' ? body : String(body ?? '');
  if (text.trim() === '') return done(null, undefined);
  try { done(null, JSON.parse(text)); } catch (e) { (e as { statusCode?: number }).statusCode = 400; done(e as Error, undefined); }
};

describe('a call with a JSON content type and no body', () => {
  it('DELETE works, a normal body still arrives, bad JSON is still refused', async () => {
    const app = Fastify();
    app.addContentTypeParser('application/json', { parseAs: 'string' }, parser as never);
    app.delete('/x/:id', async (req) => ({ ok: true, id: (req.params as { id: string }).id, body: req.body ?? null }));
    app.post('/y', async (req) => ({ got: req.body }));
    const del = await app.inject({ method: 'DELETE', url: '/x/7', headers: { 'content-type': 'application/json' } });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true, id: '7', body: null });
    expect((await app.inject({ method: 'POST', url: '/y', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' })).json()).toEqual({ got: { a: 1 } });
    expect((await app.inject({ method: 'POST', url: '/y', headers: { 'content-type': 'application/json' }, payload: '{bad' })).statusCode).toBe(400);
    await app.close();
  });
});
