import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));
vi.mock('../../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) { const res = await h.db.exec(text); const last = res[res.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));

const { observeReal, legPnl } = await import('./real-tracker.js');
const { ensureAlgoSchema, createRun } = await import('../algo/algo-store.js');
const { pool } = await import('../../db/index.js');

const U = '11111111-1111-1111-1111-111111111111';
const C = { productId: 1, symbol: 'C-BTC-105000-271026', size: -10, entry: 100 };
const P = { productId: 2, symbol: 'P-BTC-95000-271026', size: -10, entry: 80 };
const marks: Record<string, number> = { [C.symbol]: 90, [P.symbol]: 85 };
const markOf = (s: string) => marks[s] ?? null;
const rows = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows as any[];

describe('real position tracker', () => {
  beforeAll(async () => { h.db = new PGlite() as never; await ensureAlgoSchema(); });

  it('prices a sold leg as entry minus mark and a bought leg as mark minus entry, 0.001 BTC per lot', () => {
    expect(legPnl(C, 90)).toBeCloseTo(0.1);
    expect(legPnl({ ...C, size: 10 }, 90)).toBeCloseTo(-0.1);
  });

  it('opens a run only after the position has been seen for 30 s, then marks it every minute, then closes it on its last PnL', async () => {
    const t0 = 1_800_000_000_000;
    await observeReal(U, 'sub', [C, P], markOf, t0);
    expect(await rows('SELECT * FROM real_runs')).toHaveLength(0);
    await observeReal(U, 'sub', [C, P], markOf, t0 + 31_000);
    const [run] = await rows('SELECT * FROM real_runs');
    expect(run).toMatchObject({ account: 'sub', expiry: '271026', status: 'open', name: 'Sub-account · 27 Oct expiry' });
    marks[P.symbol] = 70;
    await observeReal(U, 'sub', [C, P], markOf, t0 + 100_000);
    const m = await rows('SELECT net FROM algo_run_marks WHERE run_id = $1 ORDER BY t', [run.id]);
    expect(m.map((x) => Number(x.net))).toEqual([expect.closeTo(0.05), expect.closeTo(0.2)]);
    await observeReal(U, 'sub', [], markOf, t0 + 200_000);
    const [done] = await rows('SELECT * FROM real_runs');
    expect(done.status).toBe('closed');
    expect(Number(done.net_pnl)).toBeCloseTo(0.2);
  });

  it('leaves out contracts that belong to an open algo run, so nothing is counted twice', async () => {
    const t0 = 1_800_001_000_000;
    await createRun({ userId: U, strategyId: null, name: 'Algo', dateKey: '2026-10-27', mode: 'live', status: 'entered', lots: 10, reason: '', plan: null, ref: JSON.stringify({ symbols: [C.symbol, P.symbol] }), windowStart: null, enteredAt: t0, exitAt: null });
    await observeReal(U, 'sub', [C, P], markOf, t0);
    await observeReal(U, 'sub', [C, P], markOf, t0 + 60_000);
    expect(await rows(`SELECT * FROM real_runs WHERE status = 'open'`)).toHaveLength(0);
  });
});
