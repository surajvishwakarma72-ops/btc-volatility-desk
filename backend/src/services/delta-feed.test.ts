import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify, { FastifyInstance } from 'fastify';
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

const { feedRoutes } = await import('../routes/feed.js');
const { ivRoutes } = await import('../routes/iv.js');
const { ensureIvHistorySchema, resetIvHistorySchemaCache } = await import('./iv-rank.js');
const {
  startDeltaFeed,
  stopDeltaFeed,
  pollDeltaFeed,
  getFeedStatus,
  resetFeedStatus,
} = await import('./delta-feed.js');
const { pool } = await import('../db/index.js');

describe('Task T4.4 — Delta Exchange Live Feed Wiring', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    resetIvHistorySchemaCache();
    h.db = new PGlite() as never;
    await ensureIvHistorySchema();

    app = fastify({ logger: false });
    await app.register(feedRoutes, { prefix: '/api/v1/feed' });
    await app.register(ivRoutes, { prefix: '/api/v1/iv' });
    await app.ready();
  });

  afterAll(async () => {
    stopDeltaFeed();
    if (app) await app.close();
    if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
      await (h.db as any).close();
    }
  });

  beforeEach(async () => {
    stopDeltaFeed();
    resetFeedStatus();
    await pool.query('DELETE FROM iv_history');
  });

  it('Feed service initialises without throwing', () => {
    expect(() => {
      const feed = startDeltaFeed({ immediate: false });
      expect(feed).toBeDefined();
      expect(typeof feed.stop).toBe('function');
    }).not.toThrow();

    const status = getFeedStatus();
    expect(status.running).toBe(true);
    expect(status.error_count).toBe(0);
    expect(status.last_poll_at).toBeNull();
  });

  it('On poll error: error_count increments, service keeps running', async () => {
    startDeltaFeed({ immediate: false });
    expect(getFeedStatus().running).toBe(true);
    expect(getFeedStatus().error_count).toBe(0);

    // Mock fetch error (network rejection)
    const mockNetworkErrorFetch = vi.fn().mockRejectedValue(new Error('Network offline or ECONNREFUSED'));

    // pollDeltaFeed must catch and log, never throw
    await expect(
      pollDeltaFeed({ fetchFn: mockNetworkErrorFetch as any })
    ).resolves.not.toThrow();

    const statusAfter1 = getFeedStatus();
    expect(statusAfter1.error_count).toBe(1);
    expect(statusAfter1.running).toBe(true);
    expect(statusAfter1.last_poll_at).not.toBeNull();

    // Mock HTTP error response (e.g. 500 or 404)
    const mockHttpErrorFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
    });

    await expect(
      pollDeltaFeed({ fetchFn: mockHttpErrorFetch as any })
    ).resolves.not.toThrow();

    const statusAfter2 = getFeedStatus();
    expect(statusAfter2.error_count).toBe(2);
    expect(statusAfter2.running).toBe(true);
  });

  it('GET /feed/status returns correct shape', async () => {
    startDeltaFeed({ immediate: false });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/feed/status',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('running');
    expect(body).toHaveProperty('last_poll_at');
    expect(body).toHaveProperty('error_count');

    expect(typeof body.running).toBe('boolean');
    expect(body.running).toBe(true);
    expect(body.last_poll_at === null || typeof body.last_poll_at === 'string').toBe(true);
    expect(typeof body.error_count).toBe('number');
    expect(body.error_count).toBe(0);
  });

  it('successful poll records mark_vol as decimal without multiplying by 100', async () => {
    const mockSuccessFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: [
          { symbol: 'C-BTC-95000-261031', mark_vol: 0.165 },
          { symbol: 'P-BTC-90000-261031', mark_vol: 0.224 },
        ],
      }),
    });

    await pollDeltaFeed({ fetchFn: mockSuccessFetch as any });

    const rows = (await pool.query('SELECT * FROM iv_history ORDER BY mark_vol ASC')).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // mark_vol stored as decimal (0.165 = 16.5%), never multiplied by 100
    const vols = rows.map((r: any) => Number(r.mark_vol));
    expect(vols).toContain(0.165);
    expect(vols).toContain(0.224);
  });
});
