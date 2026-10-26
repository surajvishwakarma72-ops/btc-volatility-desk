import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Bar } from '../../lib/bot/futures.js';

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

const { loadInsights, ownRunStats, clearInsightsCache } = await import('./insights-service.js');
const { ensureAlgoSchema, createRun, finishRun } = await import('./algo-store.js');

const U = '11111111-1111-1111-1111-111111111111', V = '22222222-2222-2222-2222-222222222222';
beforeAll(async () => { h.db = new PGlite() as never; await ensureAlgoSchema(); });

const bars = (from: number, n: number, t0: number): Bar[] => Array.from({ length: n }, (_, i) => { const c = 100_000 + (from + i) * 5; return { t: t0 + (from + i) * 900_000, o: c, h: c + 20, l: c - 20, c, v: 1 }; });

describe('market insights', () => {
  it('joins the two fetches without duplicates, ranks, and caches for a few hours', async () => {
    clearInsightsCache();
    let calls = 0;
    const t0 = 1_700_000_000_000;
    const fetcher = async (a: number) => { calls++; return a % 2 === 0 || true ? (calls === 1 ? bars(0, 700, t0) : bars(650, 700, t0)) : []; };
    const v = await loadInsights(fetcher, t0 + 5_000_000_000);
    expect(calls).toBe(2);
    expect(v.bars).toBe(1349); // 700 + 700 - 50 shared - the forming last bar
    expect(v.futures.length).toBeGreaterThan(0);
    await loadInsights(fetcher, t0 + 5_000_000_000 + 3_600_000);
    expect(calls).toBe(2); // cached
    await loadInsights(fetcher, t0 + 5_000_000_000 + 4 * 3_600_000);
    expect(calls).toBe(4);
  });
});

describe('your own record', () => {
  const mk = async (user: string, key: string, pnl: number, conds: Array<{ label: string; ok: boolean }>) => {
    const run = await createRun({ userId: user, strategyId: null, name: 'x', dateKey: key, mode: 'paper', status: 'entered', lots: 5, reason: '', plan: { conds }, ref: 'r', windowStart: 1, enteredAt: 1, exitAt: null });
    await finishRun(run!.id, 'exited', 'target', pnl);
  };
  it('groups finished runs by the conditions that were true at entry, per user', async () => {
    await mk(U, 'a', 10, [{ label: 'DVOL < 55', ok: true }, { label: 'ADX < 25', ok: false }]);
    await mk(U, 'b', -4, [{ label: 'DVOL < 55', ok: true }, { label: 'ADX < 25', ok: true }]);
    await mk(U, 'c', 6, [{ label: 'ADX < 25', ok: true }]);
    await mk(V, 'd', 99, [{ label: 'DVOL < 55', ok: true }]);
    const s = await ownRunStats(U);
    expect(s.finished).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.totalPnl).toBe(12);
    const dvol = s.byCondition.find((x) => x.label === 'DVOL < 55')!;
    expect(dvol).toMatchObject({ runs: 2, wins: 1, totalPnl: 6, avgPnl: 3 });
    const adx = s.byCondition.find((x) => x.label === 'ADX < 25')!;
    expect(adx).toMatchObject({ runs: 2, totalPnl: 2 });
    expect((await ownRunStats('33333333-3333-3333-3333-333333333333')).finished).toBe(0);
  });
});
