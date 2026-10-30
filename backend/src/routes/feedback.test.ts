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

const { feedbackRoutes, ensureFeedbackSchema, resetFeedbackSchemaCache } = await import('./feedback.js');
const { ensureAuthSchema } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

async function buildApp() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  await app.register(feedbackRoutes, { prefix: '/api/v1/feedback' });
  return app;
}

beforeAll(async () => {
  resetFeedbackSchemaCache();
  h.db = new PGlite() as never;
  await ensureAuthSchema();
  await ensureFeedbackSchema();
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('${TEST_USER_ID}', 'desk@example.com', '!', 'Desk', 'admin') ON CONFLICT (id) DO NOTHING`);
}, 30000);

afterAll(async () => {
  if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
    await (h.db as any).close();
  }
});

describe('User Feedback Widget Route (Task T1.6)', () => {
  it('(a) Unauthenticated request returns 401', async () => {
    const app = await buildApp();

    // 1. No token provided
    const resNoAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback',
      payload: {
        category: 'bug',
        message: 'Something is broken',
      },
    });
    expect(resNoAuth.statusCode).toBe(401);
    const bodyNoAuth = resNoAuth.json();
    expect(bodyNoAuth.success).toBe(false);
    expect(bodyNoAuth.error).toMatch(/Unauthorized/i);

    // 2. Invalid JWT token
    const resBadToken = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback',
      headers: {
        cookie: 'desk_token=invalid.jwt.token',
      },
      payload: {
        category: 'bug',
        message: 'Something is broken',
      },
    });
    expect(resBadToken.statusCode).toBe(401);
    expect(resBadToken.json().success).toBe(false);
  });

  it('(b) Message over 1000 chars returns 400', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ sub: TEST_USER_ID, role: 'admin', email: 'desk@example.com' });

    const longMessage = 'A'.repeat(1001);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback',
      headers: {
        cookie: `desk_token=${token}`,
      },
      payload: {
        category: 'bug',
        message: longMessage,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/1000/);
  });

  it('(c) Valid submission returns 201 and row exists in desk_feedback', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ sub: TEST_USER_ID, role: 'admin', email: 'desk@example.com' });

    const testPayload = {
      category: 'idea' as const,
      message: 'Add real-time Gamma heatmap to dashboard',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback',
      headers: {
        cookie: `desk_token=${token}`,
      },
      payload: testPayload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBeDefined();
    expect(body.feedback).toBeDefined();
    expect(body.feedback.category).toBe('idea');
    expect(body.feedback.message).toBe('Add real-time Gamma heatmap to dashboard');
    expect(body.feedback.userId).toBe(TEST_USER_ID);

    // Verify row exists directly in desk_feedback table
    const dbCheck = await pool.query('SELECT * FROM desk_feedback WHERE id = $1', [body.id]);
    expect(dbCheck.rows).toHaveLength(1);
    const saved = dbCheck.rows[0];
    expect(saved.id).toBe(body.id);
    expect(saved.category).toBe('idea');
    expect(saved.message).toBe('Add real-time Gamma heatmap to dashboard');
    expect(saved.user_id).toBe(TEST_USER_ID);
    expect(saved.submitted_at).toBeDefined();
  });

  it('(d) Missing category returns 400', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ sub: TEST_USER_ID, role: 'admin', email: 'desk@example.com' });

    // Missing category field completely
    const resMissing = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback',
      headers: {
        cookie: `desk_token=${token}`,
      },
      payload: {
        message: 'Feedback message without category',
      },
    });

    expect(resMissing.statusCode).toBe(400);
    const bodyMissing = resMissing.json();
    expect(bodyMissing.success).toBe(false);
    expect(bodyMissing.error).toBeDefined();

    // Invalid category value
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/api/v1/feedback',
      headers: {
        cookie: `desk_token=${token}`,
      },
      payload: {
        category: 'unsupported_category',
        message: 'Feedback message with bad category',
      },
    });

    expect(resInvalid.statusCode).toBe(400);
    const bodyInvalid = resInvalid.json();
    expect(bodyInvalid.success).toBe(false);
  });
});

