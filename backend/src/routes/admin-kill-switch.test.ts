import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
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

const { adminRoutes } = await import('./admin.js');
const { fillsRoutes, ensureFillsSchema, resetFillsSchemaCache } = await import('./fills.js');
const { wsDeskRoutes, resetActiveConnections } = await import('./ws-desk.js');
const { ensureAdminAuditSchema } = await import('../services/audit-logger.js');
const { ensureAuthSchema } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');
const {
  isAdminKillSwitchEnabled,
  isDeskHalted,
  setDeskHalted,
  resetDeskHalted,
  getDeskConfig,
} = await import('../services/kill-switch.js');

const OWNER_ID = '00000000-0000-0000-0000-000000000001';
const TRADER_ID = '22222222-2222-2222-2222-222222222222';

describe('Task T2.8 — Kill Switch + Feature Flag Gate', () => {
  let app: FastifyInstance;
  let port: number;
  let ownerToken: string;
  let traderToken: string;

  beforeAll(async () => {
    resetFillsSchemaCache();
    h.db = new PGlite() as never;
    await ensureAuthSchema();
    await ensureAdminAuditSchema(pool);
    await ensureFillsSchema();

    await pool.query(
      `INSERT INTO users (id, email, password_hash, display_name, role)
       VALUES ('${OWNER_ID}', 'owner@example.com', '!', 'Owner', 'admin')
       ON CONFLICT (id) DO NOTHING`
    );
    await pool.query(
      `INSERT INTO users (id, email, password_hash, display_name, role)
       VALUES ('${TRADER_ID}', 'trader@example.com', '!', 'Trader', 'trader')
       ON CONFLICT (id) DO NOTHING`
    );

    app = fastify({ logger: false });
    await app.register(jwt, { secret: 'test-kill-switch-jwt-secret' });
    await app.register(websocket);
    await app.register(adminRoutes, { prefix: '/api/v1/admin' });
    await app.register(fillsRoutes, { prefix: '/api/v1/fills' });
    await app.register(wsDeskRoutes);

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as any).port;

    ownerToken = app.jwt.sign({ sub: OWNER_ID, role: 'admin', email: 'owner@example.com' });
    traderToken = app.jwt.sign({ sub: TRADER_ID, role: 'trader', email: 'trader@example.com' });
  });

  afterAll(async () => {
    resetActiveConnections();
    await app.close();
    if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
      await (h.db as any).close();
    }
  });

  beforeEach(() => {
    resetDeskHalted();
    delete process.env.ENABLE_ADMIN_KILL_SWITCH;
  });

  afterEach(() => {
    resetDeskHalted();
    delete process.env.ENABLE_ADMIN_KILL_SWITCH;
  });

  describe('Security & Configuration Defaults', () => {
    it('ENABLE_ADMIN_KILL_SWITCH must default to false in all environments', () => {
      delete process.env.ENABLE_ADMIN_KILL_SWITCH;
      expect(isAdminKillSwitchEnabled()).toBe(false);
      expect(getDeskConfig().enableAdminKillSwitch).toBe(false);

      process.env.ENABLE_ADMIN_KILL_SWITCH = '';
      expect(isAdminKillSwitchEnabled()).toBe(false);

      process.env.ENABLE_ADMIN_KILL_SWITCH = '0';
      expect(isAdminKillSwitchEnabled()).toBe(false);

      process.env.ENABLE_ADMIN_KILL_SWITCH = 'false';
      expect(isAdminKillSwitchEnabled()).toBe(false);

      process.env.ENABLE_ADMIN_KILL_SWITCH = 'true';
      expect(isAdminKillSwitchEnabled()).toBe(true);
      expect(getDeskConfig().enableAdminKillSwitch).toBe(true);
    });
  });

  describe('Required Core Specifications', () => {
    it('POST kill-switch returns 403 when flag disabled', async () => {
      process.env.ENABLE_ADMIN_KILL_SWITCH = 'false';

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/kill-switch',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
      });

      expect(res.statusCode).toBe(403);
      const json = res.json();
      expect(json.success).toBe(false);
      expect(json.error).toMatch(/disabled by owner setting|feature flag/i);
      expect(isDeskHalted()).toBe(false);

      // Verify audit row logged as denied
      const audit = await pool.query(
        "SELECT * FROM desk_admin_audit WHERE action = 'kill_switch' AND result = 'denied' ORDER BY ts DESC LIMIT 1"
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    });

    it('POST kill-switch returns 200 when flag enabled + owner session', async () => {
      process.env.ENABLE_ADMIN_KILL_SWITCH = 'true';

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/kill-switch',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.halted).toBe(true);
      expect(json.flag_enabled).toBe(true);
      expect(isDeskHalted()).toBe(true);

      // Verify audit row logged as success
      const audit = await pool.query(
        "SELECT * FROM desk_admin_audit WHERE action = 'kill_switch' AND result = 'success' ORDER BY ts DESC LIMIT 1"
      );
      expect(audit.rows.length).toBeGreaterThanOrEqual(1);
      expect(audit.rows[0].actor_id).toBe(OWNER_ID);
    });

    it('POST kill-switch returns 401 for non-owner', async () => {
      // Unauthenticated request without session
      const resUnauth = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/kill-switch',
      });
      expect(resUnauth.statusCode).toBe(401);
      expect(resUnauth.json().success).toBe(false);

      // Request from authenticated non-owner (trader)
      const resTrader = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/kill-switch',
        headers: {
          authorization: `Bearer ${traderToken}`,
        },
      });
      expect([401, 403]).toContain(resTrader.statusCode);
      expect(resTrader.json().success).toBe(false);
    });

    it('fills/ingest returns 503 when halted=true', async () => {
      setDeskHalted(true);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/fills/ingest',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
        payload: [
          {
            exchange_fill_id: 'halt-test-fill-1',
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

      expect(res.statusCode).toBe(503);
      const json = res.json();
      expect(json.error).toBe('desk_halted');
    });

    it('GET status returns correct shape', async () => {
      setDeskHalted(false);
      delete process.env.ENABLE_ADMIN_KILL_SWITCH;

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/kill-switch/status',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.halted).toBe('boolean');
      expect(typeof body.flag_enabled).toBe('boolean');
      expect(body.halted).toBe(false);
      expect(body.flag_enabled).toBe(false);

      // Change state and verify response reflects it
      setDeskHalted(true);
      process.env.ENABLE_ADMIN_KILL_SWITCH = 'true';

      const res2 = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/kill-switch/status',
      });
      expect(res2.statusCode).toBe(200);
      const body2 = res2.json();
      expect(body2.halted).toBe(true);
      expect(body2.flag_enabled).toBe(true);
    });

    it('fills/ingest returns 200 when halted=false', async () => {
      setDeskHalted(false);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/fills/ingest',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
        payload: [
          {
            exchange_fill_id: 'unhalt-test-fill-1',
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

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.inserted).toBe(1);
    });
  });

  describe('WebSocket & Operational Controls', () => {
    it('WebSocket /ws/desk broadcasts {"type":"KILL_SWITCH","halted":true} to all connected clients', async () => {
      process.env.ENABLE_ADMIN_KILL_SWITCH = 'true';
      setDeskHalted(false);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
        headers: {
          Cookie: `desk_token=${ownerToken}`,
        },
      });

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      const messagePromise = new Promise<{ type: string; halted: boolean }>((resolve) => {
        ws.on('message', (data) => {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === 'KILL_SWITCH') {
              resolve(parsed);
            }
          } catch {}
        });
      });

      // Trigger kill switch via admin endpoint
      const killRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/kill-switch',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
      });
      expect(killRes.statusCode).toBe(200);

      const msg = await messagePromise;
      expect(msg).toEqual({ type: 'KILL_SWITCH', halted: true });

      ws.close();
    });

    it('Owner can resume/reset desk back to halted=false', async () => {
      process.env.ENABLE_ADMIN_KILL_SWITCH = 'true';
      setDeskHalted(true);
      expect(isDeskHalted()).toBe(true);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/kill-switch',
        headers: {
          authorization: `Bearer ${ownerToken}`,
        },
        payload: {
          resume: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.success).toBe(true);
      expect(json.halted).toBe(false);
      expect(isDeskHalted()).toBe(false);
    });
  });
});
