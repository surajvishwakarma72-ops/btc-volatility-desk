import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function }, snap: null as any }));
vi.mock('../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) { const res = await h.db.exec(text); const last = res[res.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));
vi.mock('../services/watch/sources.js', () => ({ watchService: { snapshotFor: () => h.snap } }));

const { watchRoutes } = await import('./watch.js');
const { ensureWatchSchema, logWatchEvent } = await import('../services/watch/watch-store.js');
const { pool } = await import('../db/index.js');

const MASTER = 'cd'.repeat(32);
const U = '11111111-1111-1111-1111-111111111111', V = '22222222-2222-2222-2222-222222222222';
async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (req: any, reply: any) => { try { await req.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); } });
  await app.register(watchRoutes, { prefix: '/watch' });
  return app;
}
const tokenFor = (app: any, sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: 'trader' })}` });
const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 }));

beforeAll(async () => {
  process.env.ENCRYPTION_MASTER_KEY = MASTER;
  h.db = new PGlite() as never;
  await ensureWatchSchema();
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.LIVE_TRADING_ENABLED; });

describe('stop alarm API', () => {
  it('needs a login on every route', async () => {
    const app = await build();
    for (const [m, u] of [['GET', '/watch'], ['GET', '/watch/settings'], ['PUT', '/watch/settings'], ['PUT', '/watch/live'], ['GET', '/watch/trade-key'], ['PUT', '/watch/trade-key'], ['DELETE', '/watch/trade-key'], ['GET', '/watch/events']] as const) {
      expect((await app.inject({ method: m, url: u })).statusCode, `${m} ${u}`).toBe(401);
    }
    await app.close();
  });

  it('returns the snapshot of the signed-in user, or an empty one before the first round', async () => {
    const app = await build();
    h.snap = null;
    const empty = (await app.inject({ method: 'GET', url: '/watch', headers: tokenFor(app, U) })).json();
    expect(empty.snapshot).toMatchObject({ at: null, groups: [], alarms: [], settings: { warnPoints: 20, hardPoints: 5, stopMultiple: 2 } });
    expect(empty.live).toEqual({ armed: false, dryRun: true, serverSwitch: false });
    h.snap = { at: 5, settings: { warnPoints: 20, hardPoints: 5, stopMultiple: 2 }, groups: [], alarms: [{ id: 'x', level: 'warn' }], problems: [] };
    expect((await app.inject({ method: 'GET', url: '/watch', headers: tokenFor(app, U) })).json().snapshot.alarms).toHaveLength(1);
    await app.close();
  });

  it('keeps settings per person inside a safe range, and the hard exit never earlier than the warning', async () => {
    const app = await build();
    const put = async (sub: string, body: object) => app.inject({ method: 'PUT', url: '/watch/settings', headers: tokenFor(app, sub), payload: body });
    const r = (await put(U, { warnPoints: 30, hardPoints: 8, stopMultiple: 2.5, watchReal: false })).json();
    expect(r.settings).toEqual({ warnPoints: 30, hardPoints: 8, stopMultiple: 2.5 });
    expect(r.watchReal).toBe(false);
    expect((await put(U, { warnPoints: 10, hardPoints: 40 })).json().settings).toMatchObject({ warnPoints: 10, hardPoints: 10 });
    expect((await app.inject({ method: 'GET', url: '/watch/settings', headers: tokenFor(app, V) })).json().settings).toEqual({ warnPoints: 20, hardPoints: 5, stopMultiple: 2 }); // V is unaffected
    expect((await put(U, { warnPoints: 9999 })).statusCode).toBe(400);
    expect((await put(U, { dryRun: false })).statusCode).toBe(400); // dry-run is not turned off from here
    await app.close();
  });

  it('a trading key is saved only after Delta accepts it, is encrypted, and is never returned', async () => {
    vi.stubGlobal('fetch', okFetch());
    const app = await build();
    const r = await app.inject({ method: 'PUT', url: '/watch/trade-key', headers: tokenFor(app, U), payload: { apiKey: 'TRADE-KEY-123456', apiSecret: 'TRADE-SECRET-abcdef' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ connected: true, keyLast4: '3456' });
    expect(r.body).not.toContain('TRADE-SECRET');
    const raw = JSON.stringify((await pool.query('SELECT * FROM desk_delta_trade_keys')).rows);
    expect(raw).not.toContain('TRADE-KEY-123456');
    expect(raw).not.toContain('TRADE-SECRET-abcdef');
    expect((await app.inject({ method: 'GET', url: '/watch/trade-key', headers: tokenFor(app, U) })).json()).toMatchObject({ connected: true, encryptionReady: true });
    expect((await app.inject({ method: 'GET', url: '/watch/trade-key', headers: tokenFor(app, V) })).json().connected).toBe(false); // V has none
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'ip_not_whitelisted_for_api_key' } }), { status: 403 })));
    const bad = await app.inject({ method: 'PUT', url: '/watch/trade-key', headers: tokenFor(app, V), payload: { apiKey: 'BAD-KEY-12345678', apiSecret: 'BAD-SECRET-12345678' } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/watch/trade-key', headers: tokenFor(app, V) })).json().connected).toBe(false);
    await app.close();
  });

  it('arming needs a trading key and the typed word, going live needs arming, the server switch and another typed phrase', async () => {
    vi.stubGlobal('fetch', okFetch());
    const app = await build();
    const live = async (sub: string, body: object) => app.inject({ method: 'PUT', url: '/watch/live', headers: tokenFor(app, sub), payload: body });
    const W = '33333333-3333-3333-3333-333333333333';
    expect((await live(W, { armed: true, confirm: 'ARM' })).statusCode).toBe(400); // no key yet
    await app.inject({ method: 'PUT', url: '/watch/trade-key', headers: tokenFor(app, W), payload: { apiKey: 'W-KEY-123456789', apiSecret: 'W-SECRET-123456789' } });
    expect((await live(W, { armed: true })).statusCode).toBe(400); // no typed word
    expect((await live(W, { armed: true, confirm: 'arm please' })).statusCode).toBe(400);
    const armed = await live(W, { armed: true, confirm: 'ARM' });
    expect(armed.statusCode).toBe(200);
    expect(armed.json()).toMatchObject({ liveArmed: true, dryRun: true, hasTradeKey: true });
    expect((await live(W, { dryRun: false, confirm: 'GO LIVE' })).statusCode).toBe(400); // the server switch is off
    process.env.LIVE_TRADING_ENABLED = 'true';
    expect((await live(W, { dryRun: false })).statusCode).toBe(400); // no typed phrase
    expect((await live(W, { dryRun: false, confirm: 'ARM' })).statusCode).toBe(400);
    const going = await live(W, { dryRun: false, confirm: 'GO LIVE' });
    expect(going.json()).toMatchObject({ liveArmed: true, dryRun: false, serverLiveSwitch: true });
    // disarming turns everything off and puts dry-run back
    const off = await live(W, { armed: false });
    expect(off.json()).toMatchObject({ liveArmed: false, dryRun: true });
    // and going live without arming first is refused
    expect((await live(W, { dryRun: false, confirm: 'GO LIVE' })).statusCode).toBe(400);
    await app.close();
  });

  it('removing the trading key disarms it, and nobody can arm with somebody else\'s key', async () => {
    vi.stubGlobal('fetch', okFetch());
    const app = await build();
    const live = async (sub: string, body: object) => app.inject({ method: 'PUT', url: '/watch/live', headers: tokenFor(app, sub), payload: body });
    const X = '44444444-4444-4444-4444-444444444444', Y = '55555555-5555-5555-5555-555555555555';
    await app.inject({ method: 'PUT', url: '/watch/trade-key', headers: tokenFor(app, X), payload: { apiKey: 'X-KEY-123456789', apiSecret: 'X-SECRET-123456789' } });
    expect((await live(Y, { armed: true, confirm: 'ARM' })).statusCode).toBe(400); // Y has no key of their own
    expect((await live(X, { armed: true, confirm: 'ARM' })).json().liveArmed).toBe(true);
    const del = await app.inject({ method: 'DELETE', url: '/watch/trade-key', headers: tokenFor(app, X) });
    expect(del.json().removed).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/watch/settings', headers: tokenFor(app, X) })).json()).toMatchObject({ liveArmed: false, dryRun: true, hasTradeKey: false });
    await app.close();
  });

  it('refuses to store a trading key when the server has no master key', async () => {
    const app = await build();
    const keep = process.env.ENCRYPTION_MASTER_KEY; delete process.env.ENCRYPTION_MASTER_KEY;
    vi.stubGlobal('fetch', okFetch());
    const r = await app.inject({ method: 'PUT', url: '/watch/trade-key', headers: tokenFor(app, '66666666-6666-6666-6666-666666666666'), payload: { apiKey: 'Z-KEY-123456789', apiSecret: 'Z-SECRET-123456789' } });
    expect(r.statusCode).toBe(503);
    process.env.ENCRYPTION_MASTER_KEY = keep;
    await app.close();
  });

  it('lists the hard exit events of the signed-in user only', async () => {
    await logWatchEvent(U, 'hard_exit_dry', 'DRY RUN, nothing sent: would buy 100 C-BTC-82000-261027', { symbol: 'C-BTC-82000-261027', dryRun: true });
    await logWatchEvent(V, 'hard_exit_blocked', 'not armed', {});
    const app = await build();
    const mine = (await app.inject({ method: 'GET', url: '/watch/events', headers: tokenFor(app, U) })).json().events;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: 'hard_exit_dry', dryRun: true });
    await app.close();
  });
});
