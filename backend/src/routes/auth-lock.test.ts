import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { PGlite } from '@electric-sql/pglite';
import { loginCooldown } from '../lib/cooldown.js';
import { resetSessionGuardCache } from '../services/session-guard.js';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function; close?: Function } }));
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
    end: async () => {
      if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
        await (h.db as any).close();
      }
    },
  },
}));

const { authRoutes } = await import('./auth.js');
const { ensureAuthSchema } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');

const OWNER = '00000000-0000-0000-0000-000000000001';

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(authRoutes, { prefix: '/auth' });
  return app;
}

beforeAll(async () => {
  process.env.DESK_PASSWORD = 'correct-horse';
  h.db = new PGlite() as never;
  await ensureAuthSchema();
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('${OWNER}','desk@example.com','!','Desk','admin')`);
}, 30000);

afterAll(async () => {
  if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
    await (h.db as any).close();
  }
});

beforeEach(() => {
  loginCooldown.reset();
  resetSessionGuardCache();
});

describe('Backend Auth Hardening & Entry Lock (T1.2)', () => {
  it('(a) 6th login attempt from the same IP returns 429 with retryAfterSeconds', async () => {
    const app = await build();
    const testIp = '198.51.100.42';

    // First 5 attempts from this IP fail with 401
    for (let i = 1; i <= 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': testIp },
        payload: { password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
    }

    // 6th attempt from the same IP returns 429 with retryAfterSeconds
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-for': testIp },
      payload: { password: 'wrong-password' },
    });
    expect(sixth.statusCode).toBe(429);
    const body = sixth.json();
    expect(body.success).toBe(false);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(600);
    expect(sixth.headers['retry-after']).toBe(String(body.retryAfterSeconds));

    await app.close();
  });

  it('(b) /auth/me returns 401 before login', async () => {
    const app = await build();

    // Call without cookies
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().success).toBe(false);

    // Call with Authorization header but no cookie also returns 401 (cookie-only requirement)
    const headerRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer some-random-bearer-token' },
    });
    expect(headerRes.statusCode).toBe(401);

    await app.close();
  });

  it('(c) /auth/me returns 200 with user data after valid login', async () => {
    const app = await build();

    // Valid login sets httpOnly cookie
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'correct-horse' },
    });
    expect(loginRes.statusCode).toBe(200);

    const setCookie = loginRes.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('desk_token=');

    // Extract cookie for subsequent calls
    const cookieVal = (cookieHeader as string).split(';')[0];

    // Call /api/v1/auth/me with cookie
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieVal },
    });
    expect(meRes.statusCode).toBe(200);
    const body = meRes.json();
    expect(body.success).toBe(true);
    expect(body.user).toMatchObject({
      id: OWNER,
      email: 'desk@example.com',
      role: 'admin',
    });

    await app.close();
  });

  it('(d) /auth/logout invalidates the session so a subsequent /auth/me returns 401', async () => {
    const app = await build();

    // 1. Log in
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'correct-horse' },
    });
    expect(loginRes.statusCode).toBe(200);
    const cookieHeader = Array.isArray(loginRes.headers['set-cookie']) ? loginRes.headers['set-cookie'][0] : loginRes.headers['set-cookie'];
    const cookieVal = (cookieHeader as string).split(';')[0];

    // 2. Verify /me works initially
    const beforeLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieVal },
    });
    expect(beforeLogout.statusCode).toBe(200);

    // 3. Call /auth/logout
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieVal },
    });
    expect(logoutRes.statusCode).toBe(200);
    expect(logoutRes.json().success).toBe(true);

    // 4. Subsequent /me call with the previously valid session cookie now returns 401
    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieVal },
    });
    expect(afterLogout.statusCode).toBe(401);
    expect(afterLogout.json().success).toBe(false);

    await app.close();
  });
});

