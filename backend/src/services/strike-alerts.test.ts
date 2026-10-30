import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { PGlite } from '@electric-sql/pglite';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

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
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => [] }) }) }),
  },
}));

const { alertRoutes } = await import('../routes/alerts.js');
const { wsDeskRoutes, resetActiveConnections } = await import('../routes/ws-desk.js');
const { ensureAuthSchema } = await import('./auth-store.js');
const { ensureShadowStrangleSchema } = await import('./shadow-strangle.js');
const {
  ensureStrikeAlertsSchema,
  resetStrikeAlertsSchemaCache,
  checkAndEmitStrikeAlerts,
  emitStrikeAlert,
  getStrikeAlerts,
  acknowledgeStrikeAlert,
} = await import('./strike-alerts.js');
const { pool } = await import('../db/index.js');

const OWNER_ID = '00000000-0000-0000-0000-000000000001';

describe('Task T3.1 — Strike Alert Engine', () => {
  let app: FastifyInstance;
  let port: number;
  let ownerToken: string;

  beforeAll(async () => {
    resetStrikeAlertsSchemaCache();
    h.db = new PGlite() as never;
    await ensureAuthSchema();
    await ensureShadowStrangleSchema();
    await ensureStrikeAlertsSchema();

    await pool.query(
      `INSERT INTO users (id, email, password_hash, display_name, role)
       VALUES ('${OWNER_ID}', 'owner@example.com', '!', 'Owner', 'admin')
       ON CONFLICT (id) DO NOTHING`
    );

    app = fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(jwt, { secret: 'test-strike-alerts-secret' });
    await app.register(websocket);
    await app.register(alertRoutes, { prefix: '/api/v1/alerts' });
    await app.register(wsDeskRoutes);

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as any).port;

    ownerToken = app.jwt.sign({ sub: OWNER_ID, role: 'admin', email: 'owner@example.com' });
  });

  afterAll(async () => {
    resetActiveConnections();
    await app.close();
    if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
      await (h.db as any).close();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM strike_alerts');
    await pool.query('DELETE FROM shadow_strangles');
  });

  it('Alert emits when confidence >= 70', async () => {
    // Insert cohort with confidence_score = 75
    const cohortHour = new Date().toISOString();
    const insertRes = await pool.query(
      `INSERT INTO shadow_strangles (
        cohort_hour, call_strike, put_strike, call_entry_iv, put_entry_iv,
        call_delta, put_delta, spot_at_entry, confidence_score, status, raw
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        cohortHour,
        100000,
        90000,
        0.55,
        0.55,
        0.12,
        -0.12,
        95000,
        75,
        'open',
        JSON.stringify({ iv_rank: 0.8 }),
      ]
    );

    const cohort = insertRes.rows[0];

    const emitted = await checkAndEmitStrikeAlerts(pool);
    expect(emitted.length).toBe(1);
    expect(emitted[0].cohort_id).toBe(cohort.id);
    expect(emitted[0].call_strike).toBe(100000);
    expect(emitted[0].put_strike).toBe(90000);
    expect(emitted[0].confidence_score).toBe(75);
    expect(emitted[0].iv_rank).toBe(0.8);
    expect(emitted[0].emitted_at).toBeTruthy();

    // Verify row was stored in strike_alerts table
    const stored = await pool.query(
      'SELECT * FROM strike_alerts WHERE cohort_id = $1',
      [cohort.id]
    );
    expect(stored.rows.length).toBe(1);
    expect(Number(stored.rows[0].confidence_score)).toBe(75);
    expect(stored.rows[0].acknowledged_at).toBeNull();
  });

  it('No alert when confidence < 70', async () => {
    // Insert cohort with confidence_score = 65 (below 70)
    const cohortHour = new Date().toISOString();
    const insertRes = await pool.query(
      `INSERT INTO shadow_strangles (
        cohort_hour, call_strike, put_strike, call_entry_iv, put_entry_iv,
        call_delta, put_delta, spot_at_entry, confidence_score, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        cohortHour,
        102000,
        88000,
        0.50,
        0.50,
        0.11,
        -0.11,
        95000,
        65,
        'open',
      ]
    );

    const cohort = insertRes.rows[0];

    const emitted = await checkAndEmitStrikeAlerts(pool);
    expect(emitted.length).toBe(0);

    // Verify no row in strike_alerts table
    const stored = await pool.query(
      'SELECT * FROM strike_alerts WHERE cohort_id = $1',
      [cohort.id]
    );
    expect(stored.rows.length).toBe(0);
  });

  it('GET /alerts returns correct shape', async () => {
    // Seed 2 alerts
    await emitStrikeAlert(
      {
        cohort_id: '11111111-1111-1111-1111-111111111111',
        call_strike: 105000,
        put_strike: 92000,
        confidence_score: 80,
        iv_rank: 0.75,
      },
      pool
    );
    await emitStrikeAlert(
      {
        cohort_id: '22222222-2222-2222-2222-222222222222',
        call_strike: 106000,
        put_strike: 91000,
        confidence_score: 85,
        iv_rank: 0.85,
      },
      pool
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/alerts',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(body.alerts.length).toBe(2);

    // Verify shape of alert objects
    const firstAlert = body.alerts[0];
    expect(firstAlert).toHaveProperty('id');
    expect(firstAlert).toHaveProperty('cohort_id');
    expect(firstAlert).toHaveProperty('call_strike');
    expect(firstAlert).toHaveProperty('put_strike');
    expect(firstAlert).toHaveProperty('confidence_score');
    expect(firstAlert).toHaveProperty('iv_rank');
    expect(firstAlert).toHaveProperty('emitted_at');
    expect(firstAlert).toHaveProperty('acknowledged_at');

    expect(typeof firstAlert.call_strike).toBe('number');
    expect(typeof firstAlert.put_strike).toBe('number');
    expect(typeof firstAlert.confidence_score).toBe('number');

    // Test limit query parameter
    const resLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/alerts?limit=1',
    });
    expect(resLimit.statusCode).toBe(200);
    expect(resLimit.json().alerts.length).toBe(1);
  });

  it('POST /alerts/:id/ack sets acknowledged_at', async () => {
    const alert = await emitStrikeAlert(
      {
        cohort_id: '33333333-3333-3333-3333-333333333333',
        call_strike: 104000,
        put_strike: 93000,
        confidence_score: 72,
        iv_rank: 0.65,
      },
      pool
    );

    expect(alert.acknowledged_at).toBeFalsy();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/alerts/${alert.id}/ack`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.acknowledged_at).toBeTruthy();

    // Verify persistence in database
    const dbCheck = await pool.query(
      'SELECT * FROM strike_alerts WHERE id = $1',
      [alert.id]
    );
    expect(dbCheck.rows.length).toBe(1);
    expect(dbCheck.rows[0].acknowledged_at).not.toBeNull();
  });

  it('WS receives alert broadcast', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
      headers: {
        Cookie: `desk_token=${ownerToken}`,
      },
    });

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const receivedAlertPromise = new Promise<any>((resolve) => {
      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type === 'strike_alert' || parsed.event === 'alert') {
            resolve(parsed);
          }
        } catch {}
      });
    });

    // Emit alert
    const newAlert = await emitStrikeAlert(
      {
        cohort_id: '44444444-4444-4444-4444-444444444444',
        call_strike: 107000,
        put_strike: 89000,
        confidence_score: 90,
        iv_rank: 0.92,
      },
      pool
    );

    const received = await receivedAlertPromise;
    expect(received).toBeTruthy();
    expect(received.cohort_id).toBe('44444444-4444-4444-4444-444444444444');
    expect(received.call_strike).toBe(107000);
    expect(received.put_strike).toBe(89000);
    expect(received.confidence_score).toBe(90);

    ws.close();
  });
});
