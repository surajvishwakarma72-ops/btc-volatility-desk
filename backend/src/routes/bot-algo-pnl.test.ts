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
  let liveClosed: string, liveOpen: string, liveGone: string;
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
    // the position was already gone on Delta when the engine looked, so it finished with no PnL figure of its own
    const c = (await createRun({ ...base, userId: U, name: 'Closed on Delta', mode: 'live', dateKey: '2026-10-24', enteredAt: t0 - 600_000 }))!;
    await recordMark(c.id, t0 - 540_000, 3, null); await recordMark(c.id, t0 - 480_000, -6.5, null);
    await finishRun(c.id, 'exited', 'no open position left in these contracts', null);
    liveGone = c.id;
  });

  it('a run that closed with no PnL figure keeps its last recorded minute on the curve', async () => {
    const app = await build();
    const j = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=algo', headers: tok(app, U) })).json();
    expect(j.equity.find((e: any) => e.id === liveGone)).toMatchObject({ net: -6.5, strategy: 'Closed on Delta (live)' });
    await app.close();
  });

  it('the algo curve lists the signed-in user\'s closed runs and open runs', async () => {
    const app = await build();
    const j = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=algo', headers: tok(app, U) })).json();
    expect(j.equity.map((e: any) => e.id).sort()).toEqual([liveClosed, liveGone].sort());
    expect(j.equity.find((e: any) => e.id === liveClosed)).toMatchObject({ net: 9.5, strategy: 'Night strangle (live)' });
    expect(j.open).toEqual([expect.objectContaining({ id: liveOpen, mode: 'live' })]);
    const other = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=algo', headers: tok(app, V) })).json();
    expect(other.equity).toHaveLength(0);
    await app.close();
  });

  it('real Delta positions tracked by the alarm appear on the curve (closed) and in the open list, with a minute view', async () => {
    const { pool } = await import('../db/index.js');
    const t0 = Date.now() - 7_200_000;
    const open = '33333333-3333-3333-3333-333333333331', closed = '33333333-3333-3333-3333-333333333332';
    await pool.query(`INSERT INTO real_runs (id, user_id, account, expiry, name, status, entered_at) VALUES ($1,$2,'main','271026','Main account · 27 Oct expiry','open', to_timestamp($3::double precision/1000))`, [open, U, t0]);
    await pool.query(`INSERT INTO real_runs (id, user_id, account, expiry, name, status, entered_at, exited_at, net_pnl) VALUES ($1,$2,'sub','261025','Sub-account · 26 Oct expiry','closed', to_timestamp($3::double precision/1000), to_timestamp($4::double precision/1000), 12.5)`, [closed, U, t0 - 3_600_000, t0 - 1_800_000]);
    await recordMark(open, t0 + 60_000, 2, null); await recordMark(open, t0 + 120_000, 5, null);
    const app = await build();
    const j = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=algo', headers: tok(app, U) })).json();
    expect(j.equity.find((e: any) => e.id === closed)).toMatchObject({ net: 12.5, strategy: 'Sub-account · 26 Oct expiry (live)' });
    expect(j.open.find((o: any) => o.id === open)).toMatchObject({ name: 'Main account · 27 Oct expiry', mode: 'live' });
    const d = (await app.inject({ method: 'GET', url: `/bot/runs/${open}/pnl`, headers: tok(app, U) })).json();
    expect(d.net).toEqual([2, 5]);
    expect(d.run).toMatchObject({ status: 'open', book: 'live' });
    expect((await app.inject({ method: 'GET', url: `/bot/runs/${open}/pnl`, headers: tok(app, V) })).statusCode).toBe(404);
    await app.close();
  });

  it('the PnL analysis curve keeps Paper and Live apart: algo_paper, algo_live (with your own Delta trades), and algo for both', async () => {
    const t0 = Date.now() - 5_400_000;
    const pr = (await createRun({ ...base, userId: U, name: 'Practice strangle', mode: 'paper', dateKey: '2026-10-22', enteredAt: t0 }))!;
    await recordMark(pr.id, t0 + 60_000, 7, null); await finishRun(pr.id, 'exited', 'tp', 7.5);
    const po = (await createRun({ ...base, userId: U, name: 'Practice open', mode: 'paper', dateKey: '2026-10-23', enteredAt: t0 + 600_000 }))!;
    const OPEN_REAL = '33333333-3333-3333-3333-333333333331', CLOSED_REAL = '33333333-3333-3333-3333-333333333332';
    const app = await build();
    const get = async (scope: string) => (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=' + scope, headers: tok(app, U) })).json();
    const paper = await get('algo_paper'), live = await get('algo_live'), all = await get('algo');
    const eq = (j: any) => j.equity.map((e: any) => e.id), op = (j: any) => j.open.map((o: any) => o.id);

    expect(eq(paper)).toEqual([pr.id]);                       // paper: only the paper run
    expect(op(paper)).toEqual([po.id]);                       // and only the open paper run
    expect(paper.open.every((o: any) => o.mode === 'paper')).toBe(true);

    expect(eq(live)).toEqual(expect.arrayContaining([liveClosed, liveGone, CLOSED_REAL])); // live: the live algo runs and your own Delta trade
    expect(eq(live)).not.toContain(pr.id);
    expect(op(live)).toEqual(expect.arrayContaining([liveOpen, OPEN_REAL]));
    expect(op(live)).not.toContain(po.id);
    expect(live.open.every((o: any) => o.mode === 'live')).toBe(true);

    expect(eq(all)).toEqual(expect.arrayContaining([pr.id, liveClosed, CLOSED_REAL])); // no scope split: everything, as before
    expect(op(all)).toEqual(expect.arrayContaining([po.id, liveOpen]));
    expect(eq(all).length).toBe(eq(paper).length + eq(live).length);
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
