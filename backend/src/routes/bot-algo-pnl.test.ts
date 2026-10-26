import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));
vi.mock('../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) { const res = await h.db.exec(text); const last = res[res.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));

const { botRoutes } = await import('./bot.js');
const { ensureAlgoSchema, createRun, finishRun, recordMark } = await import('../services/algo/algo-store.js');
const { ensureBotSchema } = await import('../services/bot/bot-store.js');

const U = '11111111-1111-1111-1111-111111111111', V = '22222222-2222-2222-2222-222222222222';
async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (req: any, reply: any) => { try { await req.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); } });
  await app.register(botRoutes, { prefix: '/bot' });
  return app;
}
const tok = (app: any, sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: 'trader' })}` });

const base = { strategyId: null, dateKey: '2026-10-25', status: 'entered' as const, lots: 5, reason: 'test', ref: 'r', windowStart: null, exitAt: null, plan: { rule: { exit: { netTargetUsd: 40 } } } };

describe('PnL analysis includes algo runs (Paper and Live)', () => {
  let liveClosed: string, liveOpen: string;
  beforeAll(async () => {
    h.db = new PGlite() as never;
    await ensureAlgoSchema();
    await ensureBotSchema();
    const t0 = Date.now() - 3_600_000;
    const a = (await createRun({ ...base, userId: U, name: 'Night strangle', mode: 'live', enteredAt: t0 }))!;
    await recordMark(a.id, t0 + 60_000, 4, 100_000); await recordMark(a.id, t0 + 120_000, 9, 100_100);
    await finishRun(a.id, 'exited', 'tp', 9.5);
    liveClosed = a.id;
    const b = (await createRun({ ...base, userId: U, name: 'Day strangle', mode: 'live', dateKey: '2026-10-26', enteredAt: t0 + 600_000 }))!;
    await recordMark(b.id, t0 + 660_000, -1, null); await recordMark(b.id, t0 + 720_000, 2, null);
    liveOpen = b.id;
    await createRun({ ...base, userId: V, name: 'Someone else', mode: 'paper', enteredAt: t0 });
  });

  it('the algo curve lists the signed-in user\'s closed runs and open runs', async () => {
    const app = await build();
    const j = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=algo', headers: tok(app, U) })).json();
    expect(j.equity.map((e: any) => e.id)).toEqual([liveClosed]);
    expect(j.equity[0]).toMatchObject({ net: 9.5, strategy: 'Night strangle (live)' });
    expect(j.open).toEqual([expect.objectContaining({ id: liveOpen, mode: 'live' })]);
    const other = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=algo', headers: tok(app, V) })).json();
    expect(other.equity).toHaveLength(0);
    await app.close();
  });

  it('the minute view opens an algo run, closed or open, only for its owner', async () => {
    const app = await build();
    const c = (await app.inject({ method: 'GET', url: `/bot/runs/${liveClosed}/pnl`, headers: tok(app, U) })).json();
    expect(c.net).toEqual([4, 9]);
    expect(c.tp).toBe(40);
    expect(c.run).toMatchObject({ status: 'closed', net: 9.5, exitReason: 'tp', book: 'live' });
    expect(c.stats.peak.net).toBe(9);
    const o = (await app.inject({ method: 'GET', url: `/bot/runs/${liveOpen}/pnl`, headers: tok(app, U) })).json();
    expect(o.run.status).toBe('open');
    expect((await app.inject({ method: 'GET', url: `/bot/runs/${liveClosed}/pnl`, headers: tok(app, V) })).statusCode).toBe(404);
    await app.close();
  });
});
