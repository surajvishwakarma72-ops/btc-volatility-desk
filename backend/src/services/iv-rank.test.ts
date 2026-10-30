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
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => [] }) }) }),
  },
}));

const { ivRoutes } = await import('../routes/iv.js');
const {
  computeIvRank,
  ensureIvHistorySchema,
  resetIvHistorySchemaCache,
} = await import('./iv-rank.js');
const { pool } = await import('../db/index.js');

describe('Task T4.1 — IV Rank Calculator', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    resetIvHistorySchemaCache();
    h.db = new PGlite() as never;
    await ensureIvHistorySchema();

    app = fastify({ logger: false });
    await app.register(ivRoutes, { prefix: '/api/v1/iv' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
      await (h.db as any).close();
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM iv_history');
  });

  it('computeIvRank returns correct percentile', () => {
    const history = [0.10, 0.20, 0.30, 0.40];

    // 0.25 is higher than 2 of 4 items -> 50%
    expect(computeIvRank(0.25, history)).toBe(50);

    // 0.05 is lower than all items -> 0%
    expect(computeIvRank(0.05, history)).toBe(0);

    // 0.50 is higher than all items -> 100%
    expect(computeIvRank(0.50, history)).toBe(100);

    // 0.15 is higher than 1 of 4 items -> 25%
    expect(computeIvRank(0.15, history)).toBe(25);

    // 0.35 is higher than 3 of 4 items -> 75%
    expect(computeIvRank(0.35, history)).toBe(75);
  });

  it('computeIvRank returns 0 for < 2 samples', () => {
    expect(computeIvRank(0.20, [])).toBe(0);
    expect(computeIvRank(0.20, [0.15])).toBe(0);
    expect(computeIvRank(0.20, null as any)).toBe(0);
    expect(computeIvRank(NaN, [0.10, 0.20])).toBe(0);
  });

  it('POST /iv/record inserts row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/iv/record',
      payload: {
        expiry_label: '27MAR26',
        mark_vol: 0.165,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.expiry_label).toBe('27MAR26');
    expect(body.mark_vol).toBe(0.165);
    expect(body.id).toBeDefined();

    // Verify row was inserted in database and mark_vol is decimal (0.165, never multiplied by 100)
    const dbRes = await pool.query(
      'SELECT * FROM iv_history WHERE expiry_label = $1',
      ['27MAR26']
    );
    expect(dbRes.rows.length).toBe(1);
    expect(Number(dbRes.rows[0].mark_vol)).toBe(0.165);
  });

  it('GET /iv/rank returns correct shape', async () => {
    // 1. Verify shape when no records exist
    const emptyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/iv/rank?expiry_label=27MAR26',
    });
    expect(emptyRes.statusCode).toBe(200);
    const emptyBody = emptyRes.json();
    expect(emptyBody).toEqual({
      success: true,
      expiry_label: '27MAR26',
      current_iv: null,
      iv_rank: 0,
      sample_size: 0,
    });

    // 2. Insert records: 0.10, 0.20, 0.30, 0.40, 0.50
    const vols = [0.10, 0.20, 0.30, 0.40, 0.50];
    for (const v of vols) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/iv/record',
        payload: {
          expiry_label: '27MAR26',
          mark_vol: v,
        },
      });
    }

    // 3. Query rank for 27MAR26
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/iv/rank?expiry_label=27MAR26',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Verify expected shape: {expiry_label, current_iv, iv_rank, sample_size}
    expect(body).toHaveProperty('expiry_label', '27MAR26');
    expect(body).toHaveProperty('current_iv', 0.50);
    expect(body).toHaveProperty('iv_rank');
    expect(typeof body.iv_rank).toBe('number');
    expect(body).toHaveProperty('sample_size', 5);

    // 4 of 5 readings in [0.10, 0.20, 0.30, 0.40, 0.50] are lower than 0.50 -> iv_rank = 80
    expect(body.iv_rank).toBe(80);

    // 4. Test query with custom current_iv override
    const overrideRes = await app.inject({
      method: 'GET',
      url: '/api/v1/iv/rank?expiry_label=27MAR26&current_iv=0.25',
    });
    expect(overrideRes.statusCode).toBe(200);
    const overrideBody = overrideRes.json();
    expect(overrideBody.current_iv).toBe(0.25);
    // 2 of 5 readings in [0.10, 0.20, 0.30, 0.40, 0.50] are lower than 0.25 -> 40%
    expect(overrideBody.iv_rank).toBe(40);
  });

  it('rejects invalid inputs on record and rank endpoints', async () => {
    // Missing body fields on POST
    const badPost = await app.inject({
      method: 'POST',
      url: '/api/v1/iv/record',
      payload: { expiry_label: '27MAR26' }, // missing mark_vol
    });
    expect(badPost.statusCode).toBe(400);

    // Missing expiry_label on GET
    const badGet = await app.inject({
      method: 'GET',
      url: '/api/v1/iv/rank',
    });
    expect(badGet.statusCode).toBe(400);
  });
});
