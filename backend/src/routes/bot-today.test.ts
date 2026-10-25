import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));
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
  },
}));

const { botRoutes } = await import('./bot.js');
const { ensureBotSchema } = await import('../services/bot/bot-store.js');
const { pool } = await import('../db/index.js');
const { istDateKey, istMidnightMs } = await import('../lib/bot/schedule.js');

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async function (request: any, reply: any) {
    try { await request.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
  });
  await app.register(botRoutes, { prefix: '/bot' });
  return app;
}

beforeAll(async () => {
  h.db = new PGlite() as never;
  await ensureBotSchema();
});

describe('GET /bot/today and the richer run list', () => {
  it('lists the slots of today with the stored runs, ignores futures, and shows gross, fees and slippage per run', async () => {
    const day = istDateKey(Date.now());
    const t0 = istMidnightMs(day) + 10 * 3_600_000;
    const ins = async (key: string, strat: string, book: string, status: string, extra = '') =>
      (await pool.query(
        `INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, entry_at, exit_at, planned_exit_at, margin_usd, gross_pnl, net_pnl, fees_entry, fees_exit, exit_reason, tags)
         VALUES ($1,$2,$3,'paper',$4,$5, to_timestamp($6/1000.0), to_timestamp($7/1000.0), to_timestamp($8/1000.0), 200, 6, 4.2, 0.9, 0.9, 'tp', $9) RETURNING id`,
        [key, strat, book, day, status, t0, t0 + 3_600_000, t0 + 21_600_000, JSON.stringify(extra ? { reason: extra } : {})],
      )).rows[0].id as string;
    const id = await ins(`ASIA_SHORT:${day}:always`, 'ASIA_SHORT', 'always', 'closed');
    await ins(`ASIA_SHORT:${day}:gated`, 'ASIA_SHORT', 'gated', 'closed');
    await ins(`EVE_LONG:${day}:always`, 'EVE_LONG', 'always', 'skipped', 'no tradable strikes');
    await ins(`FUT_SWEEP_LDN:${day}:always`, 'FUT_SWEEP_LDN', 'always', 'closed');
    await pool.query(`INSERT INTO bot_fills (run_id, leg_symbol, action, side, lots, intended_price, avg_price, filled, fee) VALUES ($1,'C','entry','sell',100,100,98,100,0.4)`, [id]);

    const app = await build();
    const hdr = { authorization: `Bearer ${app.jwt.sign({ sub: 't' })}` };
    const today = (await app.inject({ method: 'GET', url: '/bot/today', headers: hdr })).json();
    expect(today.success).toBe(true);
    const asia = today.slots.find((s: any) => s.id === 'ASIA_SHORT' && s.dateKey === day);
    expect(asia).toMatchObject({ state: 'closed', run: { netPnl: 4.2, grossPnl: 6, exitReason: 'tp' }, gated: { status: 'closed' } });
    expect(asia.run.fees).toBeCloseTo(1.8, 6);
    expect(today.slots.find((s: any) => s.id === 'EVE_LONG' && s.dateKey === day)).toMatchObject({ state: 'dropped', reason: 'no tradable strikes' });
    expect(today.slots.some((s: any) => s.id.startsWith('FUT_'))).toBe(false);

    const runs = (await app.inject({ method: 'GET', url: '/bot/runs?strategy=ASIA_SHORT&limit=5', headers: hdr })).json().runs;
    const mine = runs.find((r: any) => r.id === id);
    expect(mine.slippage_usd).toBeCloseTo(Math.abs(98 - 100) * 100 * 0.001, 6);
    expect(Number(mine.gross_pnl) - Number(mine.fees_entry) - Number(mine.fees_exit)).toBeCloseTo(Number(mine.net_pnl), 6);
    await app.close();
  });
});
