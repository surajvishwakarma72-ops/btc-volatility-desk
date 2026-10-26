import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import type { ChainOption } from '../lib/bot/strike-picker.js';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function }, strategiesOpen: [] as any[], closed: [] as string[] }));
vi.mock('../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) { const res = await h.db.exec(text); const last = res[res.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));

const E1 = Date.now() + 20 * 3_600_000, E2 = E1 + 86_400_000;
const code = (ms: number) => { const d = new Date(ms); const p = (n: number) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}${p(d.getUTCMonth() + 1)}${String(d.getUTCFullYear()).slice(2)}`; };
const opt = (type: 'call' | 'put', strike: number, delta: number, e: number): ChainOption => ({ symbol: `${type === 'call' ? 'C' : 'P'}-BTC-${strike}-${code(e)}`, type, strike, expiryMs: e, delta, bid: 60, ask: 65, mark: 62, iv: 0.5 });
const chain = [E1, E2].flatMap((e) => [opt('call', 105_000, 0.12, e), opt('put', 95_000, 0.12, e)]);

vi.mock('../services/algo/algo-runtime.js', () => ({
  algoEngine: { checks: new Map(), errors: new Map([['66666666-6666-6666-6666-666666666666', 'secret strategy name: boom']]) },
  loadMarket: async () => ({ spot: 100_000, chain, expiries: [E1, E2], dvol: 50, gateGo: true, gateReasons: [], bars5m: [] }),
}));
vi.mock('../services/paper/paper-terminal.js', () => ({
  paperFor: () => ({
    previewBasket: async () => ({ ok: true, marginRequired: 120, availableAfter: 880 }),
    strategies: async () => ({ open: h.strategiesOpen, closed: [] }),
    closeStrategy: async (id: string) => { h.closed.push(id); return { ok: true }; },
    cancelAll: async () => 0,
    account: async () => ({ positions: [] }),
    place: async () => ({}),
    placeBasket: async () => ({ ok: true, basketId: 'b1', stops: [] }),
  }),
}));

const { algoRoutes } = await import('./algo.js');
const { ensureAlgoSchema } = await import('../services/algo/algo-store.js');
const { defaultStrangle } = await import('../lib/algo/rule.js');
const { saveDeltaKey } = await import('../services/delta-keys.js');

const U = '11111111-1111-1111-1111-111111111111', V = '22222222-2222-2222-2222-222222222222';
async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (req: any, reply: any) => { try { await req.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); } });
  await app.register(algoRoutes, { prefix: '/algo' });
  return app;
}
const tok = (app: any, sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: 'trader' })}` });

beforeAll(async () => {
  process.env.ENCRYPTION_MASTER_KEY = 'cd'.repeat(32);
  h.db = new PGlite() as never;
  await ensureAlgoSchema();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('algo API', () => {
  it('needs a login on every route', async () => {
    const app = await build();
    for (const [m, u] of [['GET', '/algo/state'], ['GET', '/algo/events'], ['POST', '/algo/strategies'], ['POST', '/algo/preview'], ['POST', '/algo/enter-now'], ['POST', '/algo/exit-all'], ['GET', '/algo/defaults'], ['PUT', '/algo/defaults'], ['POST', '/algo/adopt']] as const) {
      expect((await app.inject({ method: m, url: u })).statusCode, `${m} ${u}`).toBe(401);
    }
    await app.close();
  });

  it('saves, lists, arms and deletes a strategy, per user', async () => {
    const app = await build();
    const save = await app.inject({ method: 'POST', url: '/algo/strategies', headers: tok(app, U), payload: { rule: defaultStrangle(), lots: 50 } });
    expect(save.statusCode).toBe(200);
    const id = save.json().strategy.id as string;
    expect(save.json().strategy.armed).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/algo/strategies/${id}/arm`, headers: tok(app, U), payload: { armed: true } })).statusCode).toBe(200);
    let st = (await app.inject({ method: 'GET', url: '/algo/state', headers: tok(app, U) })).json();
    expect(st.strategies).toHaveLength(1);
    expect(st.strategies[0].armed).toBe(true);
    // editing disarms
    await app.inject({ method: 'POST', url: '/algo/strategies', headers: tok(app, U), payload: { id, rule: defaultStrangle({ name: 'Changed' }), lots: 60 } });
    st = (await app.inject({ method: 'GET', url: '/algo/state', headers: tok(app, U) })).json();
    expect(st.strategies[0]).toMatchObject({ armed: false, lots: 60 });
    // another user sees none and cannot touch it
    expect((await app.inject({ method: 'GET', url: '/algo/state', headers: tok(app, V) })).json().strategies).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: `/algo/strategies/${id}/arm`, headers: tok(app, V), payload: { armed: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/algo/strategies/${id}`, headers: tok(app, V) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/algo/strategies/${id}`, headers: tok(app, U) })).statusCode).toBe(200);
    await app.close();
  });

  it('never shows another user an engine error that names their strategy', async () => {
    const app = await build();
    const other = (await app.inject({ method: 'GET', url: '/algo/state', headers: tok(app, U) })).json();
    expect(other.engineError).toBeNull();
    expect(JSON.stringify(other)).not.toContain('secret strategy name');
    const own = (await app.inject({ method: 'GET', url: '/algo/state', headers: tok(app, '66666666-6666-6666-6666-666666666666') })).json();
    expect(own.engineError).toContain('boom');
    await app.close();
  });

  it('rejects invalid rules with a readable reason', async () => {
    const app = await build();
    const r = await app.inject({ method: 'POST', url: '/algo/strategies', headers: tok(app, U), payload: { rule: { ...defaultStrangle(), days: [] }, lots: 5 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('days');
    await app.close();
  });

  it('live mode is locked until a trading key is saved', async () => {
    const app = await build();
    const live = defaultStrangle({ mode: 'live' });
    const no = await app.inject({ method: 'POST', url: '/algo/strategies', headers: tok(app, U), payload: { rule: live, lots: 5 } });
    expect(no.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/algo/enter-now', headers: tok(app, U), payload: { rule: live, lots: 5 } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/algo/state', headers: tok(app, U) })).json().live).toMatchObject({ tradeKey: false, canSendReal: false });
    await saveDeltaKey(U, 'trade-key-1234', 'secret-xyz', 'trade');
    const yes = await app.inject({ method: 'POST', url: '/algo/strategies', headers: tok(app, U), payload: { rule: live, lots: 5 } });
    expect(yes.statusCode).toBe(200);
    const live2 = (await app.inject({ method: 'GET', url: '/algo/state', headers: tok(app, U) })).json().live;
    expect(live2).toMatchObject({ tradeKey: true, armed: false, dryRun: true, canSendReal: false });
    expect(JSON.stringify(live2)).not.toContain('secret-xyz');
    await app.close();
  });

  it('previews the trade without placing anything', async () => {
    const app = await build();
    const r = await app.inject({ method: 'POST', url: '/algo/preview', headers: tok(app, U), payload: { rule: defaultStrangle(), lots: 50 } });
    expect(r.statusCode).toBe(200);
    const p = r.json().preview;
    expect(p.ok).toBe(true);
    expect(p.legs).toHaveLength(2);
    expect(p.expiries).toEqual([code(E1)]);
    expect(p.margin).toMatchObject({ required: 120 });
    expect(p.stops).toContain('2x');
    expect(p.plan).toBeUndefined();
    await app.close();
  });

  it('keeps the saved defaults per user', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/algo/defaults', headers: tok(app, U) })).json().defaults.name).toBe('Short strangle');
    await app.inject({ method: 'PUT', url: '/algo/defaults', headers: tok(app, U), payload: { rule: defaultStrangle({ name: 'Mine' }) } });
    expect((await app.inject({ method: 'GET', url: '/algo/defaults', headers: tok(app, U) })).json().defaults.name).toBe('Mine');
    expect((await app.inject({ method: 'GET', url: '/algo/defaults', headers: tok(app, V) })).json().defaults.name).toBe('Short strangle');
    await app.close();
  });

  it('exit-all closes every open paper strategy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const app = await build();
    h.strategiesOpen = [{ id: 's-1' }, { id: 's-2' }];
    h.closed = [];
    const r = await app.inject({ method: 'POST', url: '/algo/exit-all', headers: tok(app, U) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ paperClosed: 2 });
    expect(h.closed).toEqual(['s-1', 's-2']);
    expect(r.json().live).toBeTruthy(); // U saved a trading key above; Delta is unreachable here and that is reported, not thrown
    await app.close();
  });

  it('adopts an open paper strategy and refuses unknown ones', async () => {
    const app = await build();
    const exit = defaultStrangle().exit;
    const sid = '33333333-3333-3333-3333-333333333333';
    h.strategiesOpen = [{ id: sid, name: 'S 105000C' }];
    const ok = await app.inject({ method: 'POST', url: '/algo/adopt', headers: tok(app, U), payload: { source: 'paper', id: sid, exit: { ...exit, netTargetUsd: 10 } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().run).toMatchObject({ status: 'entered', ref: sid });
    h.strategiesOpen = [];
    expect((await app.inject({ method: 'POST', url: '/algo/adopt', headers: tok(app, U), payload: { source: 'paper', id: sid, exit } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/algo/adopt', headers: tok(app, V), payload: { source: 'delta', symbols: ['C-BTC-1-261027'], exit } })).statusCode).toBe(409);
    await app.close();
  });

  it('closes one tracked run by hand, and only your own', async () => {
    const app = await build();
    const exit = defaultStrangle().exit;
    const sid = '44444444-4444-4444-4444-444444444444';
    h.strategiesOpen = [{ id: sid, name: 'S', netPnl: 3 }];
    h.closed = [];
    const run = (await app.inject({ method: 'POST', url: '/algo/adopt', headers: tok(app, V), payload: { source: 'paper', id: sid, exit } })).json().run;
    expect((await app.inject({ method: 'POST', url: `/algo/runs/${run.id}/exit`, headers: tok(app, U) })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'POST', url: `/algo/runs/${run.id}/exit`, headers: tok(app, V) });
    expect(ok.statusCode).toBe(200);
    expect(h.closed).toEqual([sid]);
    expect((await app.inject({ method: 'POST', url: `/algo/runs/${run.id}/exit`, headers: tok(app, V) })).statusCode).toBe(409);
    await app.close();
  });

  it('lists what can be adopted, with a note when there is no key', async () => {
    const app = await build();
    h.strategiesOpen = [{ id: 'x', name: 'S', netPnl: 1, legs: [1, 2] }];
    const j = (await app.inject({ method: 'GET', url: '/algo/open-positions', headers: tok(app, '55555555-5555-5555-5555-555555555555') })).json();
    expect(j.paper).toEqual([{ id: 'x', name: 'S', netPnl: 1, legs: 2 }]);
    expect(j.delta).toEqual([]);
    expect(j.deltaNote).toMatch(/key/);
    await app.close();
  });
});
