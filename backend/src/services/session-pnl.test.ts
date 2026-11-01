import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
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

const { pnlRoutes } = await import('../routes/pnl.js');
const { ensureFillsSchema, resetFillsSchemaCache } = await import('../routes/fills.js');
const { ensureAuthSchema } = await import('./auth-store.js');
const { getSessionPnl, getTodayUtcStart } = await import('./session-pnl.js');
const { pool } = await import('../db/index.js');

describe('Task T4.3 — Session P&L Summary Panel', () => {
  let app: FastifyInstance;
  let ownerToken = '';
  const OWNER = '00000000-0000-0000-0000-000000000001';

  beforeAll(async () => {
    resetFillsSchemaCache();
    h.db = new PGlite() as never;
    await ensureAuthSchema();
    await ensureFillsSchema();

    app = fastify({ logger: false });
    await app.register(jwt, { secret: 'test-secret' });
    await app.register(pnlRoutes, { prefix: '/api/v1/pnl' });
    await app.ready();
    ownerToken = app.jwt.sign({ sub: OWNER, role: 'admin' });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
      await (h.db as any).close();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM fills');
  });

  it('GET /pnl/session returns correct shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pnl/session',
      headers: { authorization: 'Bearer ' + ownerToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('total_pnl');
    expect(body).toHaveProperty('delta_pnl');
    expect(body).toHaveProperty('gamma_pnl');
    expect(body).toHaveProperty('theta_pnl');
    expect(body).toHaveProperty('vega_pnl');
    expect(body).toHaveProperty('other_pnl');
    expect(body).toHaveProperty('fill_count');

    expect(typeof body.total_pnl).toBe('number');
    expect(typeof body.delta_pnl).toBe('number');
    expect(typeof body.gamma_pnl).toBe('number');
    expect(typeof body.theta_pnl).toBe('number');
    expect(typeof body.vega_pnl).toBe('number');
    expect(typeof body.other_pnl).toBe('number');
    expect(typeof body.fill_count).toBe('number');
  });

  it('Returns zeros when no fills today', async () => {
    // 1. Completely empty fills table
    const resEmpty = await app.inject({
      method: 'GET',
      url: '/api/v1/pnl/session',
      headers: { authorization: 'Bearer ' + ownerToken },
    });
    expect(resEmpty.statusCode).toBe(200);
    expect(resEmpty.json()).toEqual({
      total_pnl: 0,
      delta_pnl: 0,
      gamma_pnl: 0,
      theta_pnl: 0,
      vega_pnl: 0,
      other_pnl: 0,
      fill_count: 0,
    });

    // 2. Fills exist, but only from yesterday (prior to today 00:00 UTC)
    const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
    await pool.query(
      `INSERT INTO fills (
         exchange_fill_id, account_kind, instrument, symbol, side, qty, price, filled_at,
         total_pnl, delta_pnl, gamma_pnl, theta_pnl, vega_pnl, other_pnl
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      ['fill-yesterday-1', 'main', 'options', 'C-BTC-100000', 'buy', 1, 1000, yesterday, 250, 100, 50, -20, 30, 90]
    );

    const resYesterday = await app.inject({
      method: 'GET',
      url: '/api/v1/pnl/session',
      headers: { authorization: 'Bearer ' + ownerToken },
    });
    expect(resYesterday.statusCode).toBe(200);
    expect(resYesterday.json()).toEqual({
      total_pnl: 0,
      delta_pnl: 0,
      gamma_pnl: 0,
      theta_pnl: 0,
      vega_pnl: 0,
      other_pnl: 0,
      fill_count: 0,
    });
  });

  it('Aggregation sums correctly across multiple fills', async () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

    // Fill 1: today via explicit columns
    await pool.query(
      `INSERT INTO fills (
         exchange_fill_id, account_kind, instrument, symbol, side, qty, price, filled_at,
         total_pnl, delta_pnl, gamma_pnl, theta_pnl, vega_pnl, other_pnl
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      ['fill-today-1', 'main', 'options', 'C-BTC-100000', 'buy', 1, 1000, today, 17, 10, 5, -2, 3, 1]
    );

    // Fill 2: today via raw json
    const rawData = {
      total_pnl: 34,
      delta_pnl: 20,
      gamma_pnl: 10,
      theta_pnl: -4,
      vega_pnl: 6,
      other_pnl: 2,
    };
    await pool.query(
      `INSERT INTO fills (
         exchange_fill_id, account_kind, instrument, symbol, side, qty, price, filled_at, raw
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      ['fill-today-2', 'main', 'options', 'P-BTC-90000', 'sell', 2, 800, today, JSON.stringify(rawData)]
    );

    // Fill 3: yesterday (should be filtered out by filled_at >= today 00:00 UTC)
    await pool.query(
      `INSERT INTO fills (
         exchange_fill_id, account_kind, instrument, symbol, side, qty, price, filled_at,
         total_pnl, delta_pnl, gamma_pnl, theta_pnl, vega_pnl, other_pnl
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      ['fill-yesterday-2', 'main', 'options', 'C-BTC-105000', 'buy', 1, 500, yesterday, 9999, 1000, 1000, 1000, 1000, 5999]
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pnl/session',
      headers: { authorization: 'Bearer ' + ownerToken },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      total_pnl: 51,
      delta_pnl: 30,
      gamma_pnl: 15,
      theta_pnl: -6,
      vega_pnl: 9,
      other_pnl: 3,
      fill_count: 2,
    });
  });

  it('direct getSessionPnl service call produces correct result', async () => {
    const today = new Date().toISOString();
    await pool.query(
      `INSERT INTO fills (
         exchange_fill_id, account_kind, instrument, symbol, side, qty, price, filled_at,
         total_pnl, delta_pnl, gamma_pnl, theta_pnl, vega_pnl, other_pnl
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      ['fill-direct-1', 'main', 'options', 'C-BTC-100000', 'buy', 1, 1000, today, 10, 5, 2, -1, 3, 1]
    );

    const result = await getSessionPnl(OWNER);
    expect(result.fill_count).toBe(1);
    expect(result.total_pnl).toBe(10);
    expect(result.delta_pnl).toBe(5);
    expect(result.gamma_pnl).toBe(2);
    expect(result.theta_pnl).toBe(-1);
    expect(result.vega_pnl).toBe(3);
    expect(result.other_pnl).toBe(1);
  });
});
