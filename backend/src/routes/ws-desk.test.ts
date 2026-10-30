import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const { wsDeskRoutes, setWsPositionsProvider, setWsTickersProvider, resetActiveConnections } = await import('./ws-desk.js');
const { fillsRoutes, ensureFillsSchema, resetFillsSchemaCache } = await import('./fills.js');
const { ensureAuthSchema } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');

const OWNER_ID = '00000000-0000-0000-0000-000000000001';

describe('WebSocket Streams (Task T2.2)', () => {
  let app: FastifyInstance;
  let port: number;
  let token: string;

  beforeAll(async () => {
    resetFillsSchemaCache();
    h.db = new PGlite() as never;
    await ensureAuthSchema();
    await ensureFillsSchema();
    await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('${OWNER_ID}', 'desk@example.com', '!', 'Desk', 'admin') ON CONFLICT (id) DO NOTHING`);

    app = fastify({ logger: false });
    await app.register(jwt, { secret: 'ws-test-secret-12345' });
    await app.register(websocket);
    await app.register(wsDeskRoutes);
    await app.register(fillsRoutes, { prefix: '/api/v1/fills' });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as any).port;
    token = app.jwt.sign({ sub: OWNER_ID, role: 'admin', email: 'desk@example.com' });
  });

  afterAll(async () => {
    resetActiveConnections();
    await app.close();
    if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
      await (h.db as any).close();
    }
  });

  it('a. unauthenticated WS connection is rejected with code 4401', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(4401);

    // Also verify invalid cookie rejected with 4401
    const wsInvalid = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
      headers: { Cookie: 'desk_token=invalid-garbage-token' },
    });
    const codeInvalid = await new Promise<number>((resolve) => {
      wsInvalid.on('close', (c) => resolve(c));
    });
    expect(codeInvalid).toBe(4401);
  });

  it('b. authenticated connection receives positions message within 3s', async () => {
    setWsPositionsProvider(() => [
      {
        symbol: 'BTC-27DEC24-100000-C',
        size: 5,
        entry_price: 1200,
        mark_price: 1350,
        unrealized_pnl: 75,
        delta: 0.15,
        expiry: '27DEC24',
      },
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
      headers: { Cookie: `desk_token=${token}` },
    });

    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(JSON.stringify({ type: 'subscribe', channels: ['positions'] }));

    const msg = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for positions message')), 3000);
      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type === 'positions') {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    expect(msg.type).toBe('positions');
    expect(Array.isArray(msg.data)).toBe(true);
    expect(msg.data.length).toBeGreaterThan(0);
    expect(msg.data[0].symbol).toBe('BTC-27DEC24-100000-C');
    ws.close();
  });

  it('c. authenticated connection receives tickers message within 5s', async () => {
    setWsTickersProvider(() => [
      {
        symbol: 'BTC-27DEC24-100000-C',
        mark_price: 1350,
        mark_iv: 54.2,
      },
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
      headers: { Cookie: `desk_token=${token}` },
    });

    await new Promise<void>((resolve) => ws.on('open', resolve));

    ws.send(JSON.stringify({ type: 'subscribe', channels: ['tickers'] }));

    const msg = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for tickers message')), 5000);
      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type === 'tickers') {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    expect(msg.type).toBe('tickers');
    expect(Array.isArray(msg.data)).toBe(true);
    expect(msg.data.length).toBeGreaterThan(0);
    expect(msg.data[0].symbol).toBe('BTC-27DEC24-100000-C');
    ws.close();
  });

  it('d. subscribing to fills channel receives fill push after /fills/ingest POST', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
      headers: { Cookie: `desk_token=${token}` },
    });

    await new Promise<void>((resolve) => ws.on('open', resolve));

    await new Promise<void>((resolve) => {
      const handler = (raw: any) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === 'subscribed') {
            ws.off('message', handler);
            resolve();
          }
        } catch {}
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ type: 'subscribe', channels: ['fills'] }));
    });

    const fillPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for fill push')), 4000);
      ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          if (parsed.type === 'fill') {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    const testFillId = `fill-ws-test-${Date.now()}`;
    const ingestRes = await app.inject({
      method: 'POST',
      url: '/api/v1/fills/ingest',
      headers: { Cookie: `desk_token=${token}` },
      payload: {
        fills: [
          {
            exchange_fill_id: testFillId,
            account_kind: 'main',
            instrument: 'options',
            symbol: 'BTC-28DEC24-102000-C',
            side: 'buy',
            qty: 2,
            price: 1450,
            fee: 1.25,
            filled_at: new Date().toISOString(),
          },
        ],
      },
    });

    expect(ingestRes.statusCode).toBe(200);
    expect(ingestRes.json().inserted).toBe(1);

    const fillMsg = await fillPromise;
    expect(fillMsg.type).toBe('fill');
    expect(fillMsg.data).toBeDefined();
    expect(fillMsg.data.exchange_fill_id).toBe(testFillId);
    expect(fillMsg.data.symbol).toBe('BTC-28DEC24-102000-C');
    expect(fillMsg.data.side).toBe('buy');

    ws.close();
  });

  it('e. enforces max 10 concurrent WS connections per user session (closes 11th with code 4429)', async () => {
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
          headers: { Cookie: `desk_token=${token}` },
        });
        await new Promise<void>((resolve) => sock.on('open', resolve));
        sockets.push(sock);
      }

      const sock11 = new WebSocket(`ws://127.0.0.1:${port}/ws/desk`, {
        headers: { Cookie: `desk_token=${token}` },
      });
      const code11 = await new Promise<number>((resolve) => sock11.on('close', resolve));
      expect(code11).toBe(4429);
    } finally {
      for (const s of sockets) {
        try { s.close(); } catch {}
      }
    }
  });
});
