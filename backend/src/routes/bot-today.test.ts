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

  it('/bot/pnl splits options from futures, counts the always book only, and separates today from older trades', async () => {
    const day = istDateKey(Date.now());
    const t = istMidnightMs(day) + 11 * 3_600_000;
    await pool.query('DELETE FROM bot_fills; DELETE FROM bot_runs;');
    const ins = (key: string, strat: string, book: string, net: number, exitAt: number) => pool.query(
      `INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, entry_at, exit_at, net_pnl) VALUES ($1,$2,$3,'paper',$4,'closed', to_timestamp($5/1000.0), to_timestamp($5/1000.0), $6)`,
      [key, strat, book, day, exitAt, net]);
    await ins('a', 'ASIA_SHORT', 'always', 5, t);
    await ins('b', 'ASIA_SHORT', 'gated', 5, t); // same trade, must not be counted twice
    await ins('c', 'EVE_LONG', 'always', -2, t - 3 * 86_400_000); // older: in the week and the total, not today
    await ins('d', 'FUT_SWEEP_LDN', 'always', 3, t);
    await ins('e', 'FUT_SIGNAL', 'always', -1, t - 20 * 86_400_000); // older than a week: total only
    const app = await build();
    const hdr = { authorization: `Bearer ${app.jwt.sign({ sub: 't' })}` };
    const r = (await app.inject({ method: 'GET', url: '/bot/pnl', headers: hdr })).json();
    expect(r.options).toMatchObject({ today: 5, todayTrades: 1, week: 3, total: 3, trades: 2, wins: 1, openCount: 0 });
    expect(r.futures).toMatchObject({ today: 3, week: 3, total: 2, trades: 2, wins: 1 });
    await app.close();
  });

  it('/bot/runs/:id/pnl returns one trade minute by minute with its legs, stats and events, and /bot/pnl/trades the equity curve', async () => {
    await pool.query('DELETE FROM bot_minute_marks; DELETE FROM bot_events; DELETE FROM bot_legs; DELETE FROM bot_fills; DELETE FROM bot_runs;');
    const day = istDateKey(Date.now());
    const t0 = istMidnightMs(day) + 10 * 3_600_000;
    const ins = async (key: string, strat: string, net: number, exitMin: number) => (await pool.query(
      `INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, entry_at, exit_at, margin_usd, gross_pnl, net_pnl, fees_entry, fees_exit, exit_reason)
       VALUES ($1,$2,'always','paper',$3,'closed', to_timestamp($4/1000.0), to_timestamp($5/1000.0), 200, $6, $6, 1, 1, 'tp') RETURNING id`,
      [key, strat, day, t0, t0 + exitMin * 60_000, net])).rows[0].id as string;
    const a = await ins('A', 'ASIA_SHORT', 8, 90), b = await ins('B', 'ASIA_SHORT', -12, 120), c = await ins('C', 'FUT_SWEEP_LDN', 3, 30);
    await pool.query(`INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, entry_at, exit_at, net_pnl) VALUES ('G','ASIA_SHORT','gated','paper',$1,'closed', to_timestamp($2/1000.0), to_timestamp($2/1000.0), 8)`, [day, t0]);
    await pool.query(`INSERT INTO bot_legs (run_id, symbol, type, side, strike, expiry_ms, lots, entry_price, role) VALUES ($1,'C-82000','call','short',82000,1,100,100,'body'),($1,'P-78000','put','short',78000,1,100,120,'body')`, [a]);
    const nets = [0, 2, 5, 9, 7, 4, 8];
    for (let i = 0; i < nets.length; i++) {
      const snap = { tpTargetUsd: 20, stopLevels: [{ symbol: 'C-82000', stopAt: 200 }], legs: [{ symbol: 'C-82000', mark: 100 - i, pnl: nets[i]! / 2, iv: 38, delta: 0.12 }, { symbol: 'P-78000', mark: 120 - i, pnl: nets[i]! / 2, iv: 40, delta: -0.13 }] };
      await pool.query('INSERT INTO bot_minute_marks (run_id, minute_ms, net_pnl, gross_pnl, pct_margin, spot, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7)', [a, t0 + i * 60_000, nets[i], nets[i]! + 1, nets[i]! / 200, 80_000 + i, JSON.stringify(snap)]);
    }
    await pool.query("INSERT INTO bot_events (run_id, strategy, type, severity, message) VALUES ($1,'ASIA_SHORT','exit_tp','info','take profit hit')", [a]);
    const app = await build();
    const hdr = { authorization: `Bearer ${app.jwt.sign({ sub: 't' })}` };
    const r = (await app.inject({ method: 'GET', url: `/bot/runs/${a}/pnl`, headers: hdr })).json();
    expect(r.success).toBe(true);
    expect(r.t).toHaveLength(7);
    expect(r.net).toEqual(nets);
    expect(r.spot[6]).toBe(80_006);
    expect(r.run).toMatchObject({ strategy: 'ASIA_SHORT', margin: 200, net: 8, exitReason: 'tp' });
    expect(r.legs.map((l: any) => l.symbol)).toEqual(['C-82000', 'P-78000']);
    expect(r.legs[0].mark).toEqual([100, 99, 98, 97, 96, 95, 94]);
    expect(r.legs[1].pnl[3]).toBe(4.5);
    expect(r.tp).toBe(20);
    expect(r.stats.peak).toMatchObject({ net: 9, atMin: 3 });
    expect(r.stats.maxDrawdown.amount).toBe(5);
    expect(r.events[0]).toMatchObject({ type: 'exit_tp' });
    expect((await app.inject({ method: 'GET', url: '/bot/runs/00000000-0000-0000-0000-000000000000/pnl', headers: hdr })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/bot/runs/nope/pnl', headers: hdr })).statusCode).toBe(400);

    const all = (await app.inject({ method: 'GET', url: '/bot/pnl/trades', headers: hdr })).json();
    expect(all.stats.trades).toBe(3); // the gated copy is not counted
    expect(all.equity.map((e: any) => e.cum)).toEqual([3, 11, -1]); // exit order: C (30 min), A (90), B (120)
    expect(all.stats).toMatchObject({ netTotal: -1, wins: 2, losses: 1 });
    const opts = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=options', headers: hdr })).json();
    expect(opts.stats.trades).toBe(2);
    const futs = (await app.inject({ method: 'GET', url: '/bot/pnl/trades?scope=futures', headers: hdr })).json();
    expect(futs.stats.trades).toBe(1);
    expect(c).toBeTruthy(); expect(b).toBeTruthy();
    await app.close();
  });
});
