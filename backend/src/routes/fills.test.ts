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

const { fillsRoutes, ensureFillsSchema, resetFillsSchemaCache } = await import('./fills.js');
const { ensureAuthSchema } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');

const OWNER = '00000000-0000-0000-0000-000000000001';
const TRADER = '22222222-2222-2222-2222-222222222222';

async function buildApp() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  await app.register(fillsRoutes, { prefix: '/api/v1/fills' });
  return app;
}

beforeAll(async () => {
  resetFillsSchemaCache();
  h.db = new PGlite() as never;
  await ensureAuthSchema();
  await ensureFillsSchema();
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('${OWNER}', 'desk@example.com', '!', 'Desk', 'admin') ON CONFLICT (id) DO NOTHING`);
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('${TRADER}', 'trader@example.com', '!', 'Trader', 'trader') ON CONFLICT (id) DO NOTHING`);
}, 30000);

afterAll(async () => {
  if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
    await (h.db as any).close();
  }
});

describe('fills privacy', () => {
  it('shows each user only their own fills', async () => {
    const app = await buildApp();
    await app.ready();
    await pool.query(`INSERT INTO fills (exchange_fill_id, account_kind, user_id, instrument, symbol, side, qty, price, filled_at) VALUES ('own-1','account','${OWNER}','option','C-BTC-1-011126','buy',1,1,now()),('own-2','account','${TRADER}','option','C-BTC-2-011126','buy',1,1,now())`);
    const list = async (id: string, role: string) => (await app.inject({ method: 'GET', url: '/api/v1/fills', headers: { authorization: `Bearer ${app.jwt.sign({ sub: id, role })}` } })).json().fills.map((f: { symbol: string }) => f.symbol);
    expect(await list(TRADER, 'trader')).toEqual(['C-BTC-2-011126']);
    expect(await list(OWNER, 'admin')).not.toContain('C-BTC-2-011126');
    await pool.query(`DELETE FROM fills WHERE exchange_fill_id IN ('own-1','own-2')`);
  });
});

describe('Fills Table and Ingest API (Task T2.1)', () => {
  it('(a) GET /fills returns 401 without session', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/fills',
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Unauthorized/i);
  });

  it('(b) POST /fills/ingest returns 403 for non-owner', async () => {
    const app = await buildApp();
    const traderToken = app.jwt.sign({ sub: TRADER, role: 'trader', email: 'trader@example.com' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fills/ingest',
      headers: {
        cookie: `desk_token=${traderToken}`,
      },
      payload: [
        {
          exchange_fill_id: 'test-unauth-01',
          account_kind: 'main',
          instrument: 'options',
          symbol: 'C-BTC-100000-261030',
          side: 'buy',
          qty: 1,
          price: 1500,
          filled_at: '2026-10-30T10:00:00Z',
        },
      ],
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Owner role required/i);
  });

  it('(c) POST /fills/ingest inserts new fills and returns correct counts', async () => {
    const app = await buildApp();
    const ownerToken = app.jwt.sign({ sub: OWNER, role: 'owner', email: 'desk@example.com' });

    const fillA = {
      exchange_fill_id: 'fill-test-101',
      account_kind: 'main' as const,
      instrument: 'options',
      symbol: 'C-BTC-100000-261030',
      side: 'buy' as const,
      qty: 1.5,
      price: 1250.0,
      fee: 1.25,
      fee_tax: 0.22,
      liquidity: 'maker',
      filled_at: '2026-10-30T10:00:00.000Z',
    };

    const fillB = {
      exchange_fill_id: 'fill-test-102',
      account_kind: 'main' as const,
      instrument: 'options',
      symbol: 'P-BTC-95000-261030',
      side: 'sell' as const,
      qty: 2.0,
      price: 850.5,
      fee: 1.7,
      fee_tax: 0.31,
      liquidity: 'taker',
      filled_at: '2026-10-30T10:05:00.000Z',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fills/ingest',
      headers: {
        cookie: `desk_token=${ownerToken}`,
      },
      payload: [fillA, fillB],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.inserted).toBe(2);
    expect(body.skipped).toBe(0);

    // Verify rows exist in database
    const dbCheck = await pool.query('SELECT * FROM fills WHERE exchange_fill_id IN ($1, $2)', ['fill-test-101', 'fill-test-102']);
    expect(dbCheck.rows).toHaveLength(2);
  });

  it('(d) POST /fills/ingest with duplicate exchange_fill_id skips (upsert, not error)', async () => {
    const app = await buildApp();
    const ownerToken = app.jwt.sign({ sub: OWNER, role: 'owner', email: 'desk@example.com' });

    const duplicateFill = {
      exchange_fill_id: 'fill-test-101', // Already inserted in test (c)
      account_kind: 'main' as const,
      instrument: 'options',
      symbol: 'C-BTC-100000-261030',
      side: 'buy' as const,
      qty: 1.5,
      price: 1250.0,
      filled_at: '2026-10-30T10:00:00.000Z',
    };

    const newFill = {
      exchange_fill_id: 'fill-test-103', // New fill
      account_kind: 'main' as const,
      instrument: 'options',
      symbol: 'C-BTC-105000-261030',
      side: 'sell' as const,
      qty: 0.5,
      price: 620.0,
      filled_at: '2026-10-30T10:10:00.000Z',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/fills/ingest',
      headers: {
        cookie: `desk_token=${ownerToken}`,
      },
      payload: [duplicateFill, newFill],
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.inserted).toBe(1);
    expect(body.skipped).toBe(1);
  });

  it('(e) GET /fills returns fills filtered by symbol', async () => {
    const app = await buildApp();
    const ownerToken = app.jwt.sign({ sub: OWNER, role: 'owner', email: 'desk@example.com' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/fills?symbol=P-BTC-95000-261030',
      headers: {
        cookie: `desk_token=${ownerToken}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.fills)).toBe(true);
    expect(body.fills.length).toBeGreaterThan(0);
    for (const fill of body.fills) {
      expect(fill.symbol).toBe('P-BTC-95000-261030');
    }
  });

  it('(f) GET /fills respects limit param', async () => {
    const app = await buildApp();
    const ownerToken = app.jwt.sign({ sub: OWNER, role: 'owner', email: 'desk@example.com' });

    // We have at least 3 fills inserted across previous tests: fill-test-101, fill-test-102, fill-test-103
    const resLimit1 = await app.inject({
      method: 'GET',
      url: '/api/v1/fills?limit=1',
      headers: {
        cookie: `desk_token=${ownerToken}`,
      },
    });

    expect(resLimit1.statusCode).toBe(200);
    const body1 = resLimit1.json();
    expect(body1.success).toBe(true);
    expect(body1.fills).toHaveLength(1);

    const resLimit2 = await app.inject({
      method: 'GET',
      url: '/api/v1/fills?limit=2',
      headers: {
        cookie: `desk_token=${ownerToken}`,
      },
    });

    expect(resLimit2.statusCode).toBe(200);
    const body2 = resLimit2.json();
    expect(body2.success).toBe(true);
    expect(body2.fills).toHaveLength(2);
  });
});

