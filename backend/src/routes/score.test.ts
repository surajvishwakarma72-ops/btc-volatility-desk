import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function }, closed: [] as any[] }));
vi.mock('../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) { const res = await h.db.exec(text); const last = res[res.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));
vi.mock('../services/paper/paper-terminal.js', () => ({ paperFor: () => ({ strategies: async () => ({ open: [], closed: h.closed }) }) }));

const { scoreRoutes, classifyPaperLegs } = await import('./score.js');
const { ensureBotSchema } = await import('../services/bot/bot-store.js');
const { ensureAlgoSchema, createRun, finishRun } = await import('../services/algo/algo-store.js');
const { pool } = await import('../db/index.js');
const { recordPaperMark, getPaperMarks, ensurePaperMarksSchema } = await import('../services/paper/paper-marks.js');

const U = '11111111-1111-1111-1111-111111111111', V = '22222222-2222-2222-2222-222222222222';
async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (req: any, reply: any) => { try { await req.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); } });
  await app.register(scoreRoutes, { prefix: '/score' });
  return app;
}
const tok = (app: any, sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: 'trader' })}` });

beforeAll(async () => {
  h.db = new PGlite() as never;
  await ensureBotSchema(); await ensureAlgoSchema(); await ensurePaperMarksSchema();
});

describe('classifying a Paper strategy', () => {
  const L = (symbol: string, side: 'buy' | 'sell') => ({ symbol, side, lots: 10 });
  it('names the structure from the legs', () => {
    expect(classifyPaperLegs([L('C-BTC-105000-271026', 'sell'), L('P-BTC-95000-271026', 'sell')]).label).toBe('Short strangle');
    expect(classifyPaperLegs([L('C-BTC-100000-271026', 'sell'), L('P-BTC-100000-271026', 'sell')]).label).toBe('Short straddle');
    expect(classifyPaperLegs([L('C-BTC-100000-271026', 'buy'), L('P-BTC-100000-271026', 'buy')]).label).toBe('Long straddle');
    expect(classifyPaperLegs([L('BTCUSD', 'buy')]).label).toBe('BTC futures long');
    expect(classifyPaperLegs([L('BTCUSD', 'sell')]).label).toBe('BTC futures short');
    expect(classifyPaperLegs([L('C-BTC-100000-271026', 'sell')]).label).toBe('Short single call');
    expect(classifyPaperLegs([L('C-BTC-100000-271026', 'sell'), L('C-BTC-101000-271026', 'buy')]).label).toBe('Mixed or other');
    expect(classifyPaperLegs([L('C-BTC-1-271026', 'sell'), L('C-BTC-2-271026', 'buy'), L('P-BTC-3-271026', 'sell'), L('P-BTC-4-271026', 'buy')]).label).toBe('Four-leg spread');
  });
});

describe('GET /score/trades', () => {
  it('needs a login and a valid source', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/score/trades?source=bot' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/score/trades?source=nope', headers: tok(app, U) })).statusCode).toBe(400);
    await app.close();
  });

  it('bot: closed runs of the always book, with the strategy name and the entry day', async () => {
    const t0 = Date.parse('2026-10-20T16:00:00Z');
    const ins = (key: string, strat: string, book: string, status: string, net: number | null) => pool.query(
      `INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, entry_at, exit_at, net_pnl) VALUES ($1,$2,$3,'paper','2026-10-20',$4, to_timestamp($5/1000.0), to_timestamp($6/1000.0), $7)`,
      [key, strat, book, status, t0, t0 + 3_600_000, net]);
    await ins('a', 'NY_SHORT', 'always', 'closed', 12.5);
    await ins('b', 'NY_SHORT', 'gated', 'closed', 12.5);
    await ins('c', 'ASIA_SHORT', 'always', 'open', null);
    await ins('d', 'EVE_LONG', 'always', 'skipped', null);
    const app = await build();
    const j = (await app.inject({ method: 'GET', url: '/score/trades?source=bot', headers: tok(app, U) })).json();
    expect(j.trades).toHaveLength(1);
    expect(j.trades[0]).toMatchObject({ strategy: 'NY_SHORT', dateKey: '2026-10-20', net: 12.5 });
    expect(j.trades[0].label).toMatch(/New York/);
    expect((await app.inject({ method: 'GET', url: '/score/trades?source=bot&book=gated', headers: tok(app, U) })).json().trades).toHaveLength(1);
    await app.close();
  });

  it('algo: only your own finished runs, grouped by the rule name', async () => {
    const mk = async (user: string, key: string, name: string, pnl: number | null) => {
      const run = await createRun({ userId: user, strategyId: null, name: name + ' 271026', dateKey: key, mode: 'paper', status: 'entered', lots: 5, reason: '', plan: { rule: { name } }, ref: 'r', windowStart: 1, enteredAt: Date.parse('2026-10-21T17:00:00Z'), exitAt: null });
      if (pnl != null) await finishRun(run!.id, 'exited', 'target', pnl);
    };
    await mk(U, 'k1', 'Short strangle', 7);
    await mk(U, 'k2', 'Short strangle', -3);
    await mk(U, 'k3', 'Short strangle', null); // still open: not a result yet
    await mk(V, 'k4', 'Short strangle', 99);
    const app = await build();
    const j = (await app.inject({ method: 'GET', url: '/score/trades?source=algo', headers: tok(app, U) })).json();
    expect(j.trades.map((t: any) => t.net).sort()).toEqual([-3, 7]);
    expect(j.trades[0]).toMatchObject({ strategy: 'Short strangle', label: 'Short strangle', dateKey: '2026-10-21' });
    await app.close();
  });

  it('paper: closed strategies grouped by structure', async () => {
    const t = Date.parse('2026-10-22T04:00:00Z');
    h.closed = [
      { id: 'p1', name: 'x', openedAt: t, closedAt: t + 3600_000, netPnl: 4, legs: [{ symbol: 'C-BTC-105000-271026', side: 'sell', lots: 10 }, { symbol: 'P-BTC-95000-271026', side: 'sell', lots: 10 }] },
      { id: 'p2', name: 'y', openedAt: t, closedAt: t + 3600_000, netPnl: null, legs: [{ symbol: 'BTCUSD', side: 'buy', lots: 10 }] },
    ];
    const app = await build();
    const j = (await app.inject({ method: 'GET', url: '/score/trades?source=paper', headers: tok(app, U) })).json();
    expect(j.trades).toHaveLength(1);
    expect(j.trades[0]).toMatchObject({ id: 'p1', label: 'Short strangle', net: 4, dateKey: '2026-10-22' });
    await app.close();
  });
});

describe('paper strategy minute marks', () => {
  it('one sample per minute, oldest first', async () => {
    const id = '99999999-9999-9999-9999-999999999999';
    await recordPaperMark(id, 1_700_000_041_000, 1.5);
    await recordPaperMark(id, 1_700_000_055_000, 9); // same minute: ignored
    await recordPaperMark(id, 1_700_000_101_000, -2);
    const m = await getPaperMarks(id);
    expect(m.net).toEqual([1.5, -2]);
    expect(m.t[1]! - m.t[0]!).toBe(60_000);
  });
});
