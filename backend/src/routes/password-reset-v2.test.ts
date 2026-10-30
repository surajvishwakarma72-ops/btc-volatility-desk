import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { PGlite } from '@electric-sql/pglite';

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
const { ensureAuthSchema, createUser } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');
const { hashPassword } = await import('../lib/password.js');

const OWNER = '00000000-0000-0000-0000-000000000001';

async function buildApp() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(authRoutes, { prefix: '/auth' });
  return app;
}

let traderUser: any = null;
let targetUser: any = null;

beforeAll(async () => {
  process.env.DESK_PASSWORD = 'correct-horse';
  h.db = new PGlite() as never;
  await ensureAuthSchema();
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('${OWNER}','desk@example.com','!','Desk','admin')`);
  traderUser = await createUser('trader@example.com', await hashPassword('trader-pw-12345'), 'Trader');
  targetUser = await createUser('target@example.com', await hashPassword('initial-pw-12345'), 'Target');
}, 30000);

afterAll(async () => {
  if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
    await (h.db as any).close();
  }
});

describe('Password Reset v2 & desk_password_resets Table (Task T1.3)', () => {
  let pendingResetId = '';
  let issuedToken = '';

  it('(a) Request returns 200 for unknown email (no leak)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email: 'unknown@example.com' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);

    // Verify no row was created in desk_password_resets for non-existent user
    const checkDb = await pool.query('SELECT * FROM desk_password_resets WHERE user_id NOT IN ($1, $2, $3)', [OWNER, traderUser.id, targetUser.id]);
    expect(checkDb.rows.length).toBe(0);

    await app.close();
  });

  it('(b) Request creates a pending row in desk_password_resets', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/request',
      payload: { email: 'target@example.com' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.reset_id).toBeTruthy();

    pendingResetId = body.reset_id;
    issuedToken = body.token;

    // Verify database row state
    const dbRes = await pool.query('SELECT * FROM desk_password_resets WHERE id = $1', [pendingResetId]);
    expect(dbRes.rows.length).toBe(1);
    const row = dbRes.rows[0];
    expect(row.user_id).toBe(targetUser.id);
    expect(row.status).toBe('pending');
    expect(row.pending_owner_approval).toBe(true);
    expect(row.token_hash).toBeTruthy();
    expect(row.token_hash.length).toBe(64); // sha-256 hex string

    await app.close();
  });

  it('(c) Non-owner cannot call /approve (returns 403)', async () => {
    const app = await buildApp();
    const traderToken = app.jwt.sign({ sub: traderUser.id, role: 'trader', email: traderUser.email });

    // Non-owner session with role 'trader'
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/approve',
      headers: { authorization: `Bearer ${traderToken}` },
      payload: { reset_id: pendingResetId },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);

    // Also unauthenticated call returns 403
    const unauthRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/approve',
      payload: { reset_id: pendingResetId },
    });
    expect(unauthRes.statusCode).toBe(403);

    await app.close();
  });

  it('(d) Owner can approve a pending reset', async () => {
    const app = await buildApp();
    const ownerSession = app.jwt.sign({ sub: OWNER, role: 'owner', email: 'desk@example.com' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/approve',
      headers: { authorization: `Bearer ${ownerSession}` },
      payload: { reset_id: pendingResetId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    // Verify database row updated to approved
    const dbRes = await pool.query('SELECT * FROM desk_password_resets WHERE id = $1', [pendingResetId]);
    const row = dbRes.rows[0];
    expect(row.status).toBe('approved');
    expect(row.pending_owner_approval).toBe(false);
    expect(row.decided_at).toBeTruthy();
    expect(row.decided_by).toBe(OWNER);

    await app.close();
  });

  it('(e) Complete with valid token sets password and marks row \'used\'', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/complete',
      payload: {
        token: issuedToken,
        new_password: 'brand-new-secret-password-1234',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    // Verify database row marked 'used'
    const dbRes = await pool.query('SELECT * FROM desk_password_resets WHERE id = $1', [pendingResetId]);
    const row = dbRes.rows[0];
    expect(row.status).toBe('used');

    // Verify target user can now log in with the new password
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'target@example.com',
        password: 'brand-new-secret-password-1234',
      },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().success).toBe(true);

    await app.close();
  });

  it('(f) Complete with already-used token returns 410', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password-reset/complete',
      payload: {
        token: issuedToken,
        new_password: 'yet-another-password-5678',
      },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json().success).toBe(false);
    expect(res.json().error).toMatch(/already been used/i);

    await app.close();
  });
});

