import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

const { authRoutes } = await import('./auth.js');
const { deltaRoutes } = await import('./delta.js');
const { ensureAuthSchema } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');
const { seal, open, MasterKeyMissing } = await import('../lib/crypto.js');
const { hashPassword, verifyPassword } = await import('../lib/password.js');

const MASTER = 'ab'.repeat(32);

async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', async (req: any, reply: any) => { try { await req.jwtVerify(); } catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); } });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(deltaRoutes, { prefix: '/delta' });
  return app;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  process.env.DESK_PASSWORD = 'correct-horse';
  process.env.ENCRYPTION_MASTER_KEY = MASTER;
  delete process.env.DELTA_API_KEY;
  delete process.env.DELTA_API_SECRET;
  h.db = new PGlite() as never;
  await ensureAuthSchema();
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('00000000-0000-0000-0000-000000000001','desk@local','!','Desk','trader')`);
  await ensureAuthSchema().catch(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('password hashing and secret encryption', () => {
  it('verifies the right password only, and a placeholder hash never verifies', async () => {
    const hsh = await hashPassword('a-long-password');
    expect(await verifyPassword('a-long-password', hsh)).toBe(true);
    expect(await verifyPassword('a-long-passwore', hsh)).toBe(false);
    expect(await verifyPassword('!', '!')).toBe(false);
    expect(hsh).not.toContain('a-long-password');
  });

  it('seals and opens a secret, uses fresh salt and iv each time, and refuses tampered data or a missing master key', () => {
    const a = seal('my-secret'), b = seal('my-secret');
    expect(open(a)).toBe('my-secret');
    expect(a.data).not.toBe(b.data);
    expect(a.iv).not.toBe(b.iv);
    expect(JSON.stringify(a)).not.toContain('my-secret');
    expect(() => open({ ...a, data: Buffer.from('tampered-bytes').toString('base64') })).toThrow();
    const keep = process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ENCRYPTION_MASTER_KEY;
    expect(() => seal('x')).toThrow(MasterKeyMissing);
    process.env.ENCRYPTION_MASTER_KEY = keep;
  });
});

describe('invite-code sign-up, login and the owner', () => {
  it('the owner signs in with just the desk password, as admin, and makes an invite that a friend uses once', async () => {
    const app = await build();
    const owner = (await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'correct-horse' } })).json();
    expect(owner.user).toMatchObject({ email: 'desk@local', role: 'admin' });
    const inv = (await app.inject({ method: 'POST', url: '/auth/invites', headers: bearer(owner.token), payload: { label: 'Ravi' } })).json();
    expect(inv.code).toMatch(/^[A-Za-z0-9_-]{12}$/);

    const body = { email: 'Ravi@Example.com', password: 'a-long-password', displayName: 'Ravi', inviteCode: inv.code };
    const ok = await app.inject({ method: 'POST', url: '/auth/signup', payload: body });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user).toMatchObject({ email: 'ravi@example.com', role: 'trader' });
    // the single use is gone
    const again = await app.inject({ method: 'POST', url: '/auth/signup', payload: { ...body, email: 'other@example.com' } });
    expect(again.statusCode).toBe(403);
    // the stored password is a hash
    const row = (await pool.query(`SELECT password_hash FROM users WHERE email = 'ravi@example.com'`)).rows[0] as any;
    expect(row.password_hash).toMatch(/^scrypt\$/);
    await app.close();
  });

  it('rejects a short password, a wrong code, a revoked code and a duplicate email without using up the code', async () => {
    const app = await build();
    const owner = (await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'correct-horse' } })).json();
    const mk = async (maxUses = 1) => (await app.inject({ method: 'POST', url: '/auth/invites', headers: bearer(owner.token), payload: { maxUses } })).json();
    const base = { email: 'a@example.com', password: 'a-long-password', displayName: 'A' };
    expect((await app.inject({ method: 'POST', url: '/auth/signup', payload: { ...base, password: 'short', inviteCode: 'whatever1' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/auth/signup', payload: { ...base, inviteCode: 'not-a-code' } })).statusCode).toBe(403);
    const revoked = await mk();
    await app.inject({ method: 'DELETE', url: `/auth/invites/${revoked.id}`, headers: bearer(owner.token) });
    expect((await app.inject({ method: 'POST', url: '/auth/signup', payload: { ...base, inviteCode: revoked.code } })).statusCode).toBe(403);
    const good = await mk(2);
    expect((await app.inject({ method: 'POST', url: '/auth/signup', payload: { ...base, inviteCode: good.code } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/auth/signup', payload: { ...base, inviteCode: good.code } })).statusCode).toBe(409); // same email
    const list = (await app.inject({ method: 'GET', url: '/auth/invites', headers: bearer(owner.token) })).json().invites;
    expect(list.find((x: any) => x.id === good.id).uses).toBe(1); // the failed duplicate gave its use back
    await app.close();
  });

  it('a friend logs in with email and password, is not an admin, and cannot make invites or see the list', async () => {
    const app = await build();
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ravi@example.com', password: 'a-long-password' } });
    expect(login.statusCode).toBe(200);
    const t = login.json().token;
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(t) })).json().data).toMatchObject({ email: 'ravi@example.com', role: 'trader', deltaConnected: false });
    expect((await app.inject({ method: 'POST', url: '/auth/invites', headers: bearer(t), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/auth/invites', headers: bearer(t) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/auth/invites' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ravi@example.com', password: 'wrong-password-x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@example.com', password: 'a-long-password' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'wrong' } })).statusCode).toBe(401);
    await app.close();
  });
});

describe('each user keeps their own Delta key', () => {
  const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 }));

  it('saves a key after Delta accepts it, stores only ciphertext, and never returns the secret', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    const app = await build();
    const t = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ravi@example.com', password: 'a-long-password' } })).json().token;
    const put = await app.inject({ method: 'PUT', url: '/delta/credentials', headers: bearer(t), payload: { apiKey: 'RAVI-KEY-123456', apiSecret: 'RAVI-SECRET-abcdef' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ connected: true, keyLast4: '3456' });
    expect(put.body).not.toContain('RAVI-SECRET');
    expect(String((f.mock.calls[0] as any)[0])).toContain('/v2/wallet/balances'); // validated with one read-only call
    const raw = JSON.stringify((await pool.query('SELECT * FROM desk_delta_keys')).rows);
    expect(raw).not.toContain('RAVI-KEY-123456');
    expect(raw).not.toContain('RAVI-SECRET-abcdef');
    const st = (await app.inject({ method: 'GET', url: '/delta/credentials', headers: bearer(t) })).json();
    expect(st).toMatchObject({ connected: true, keyLast4: '3456', encryptionReady: true });
    expect(JSON.stringify(st)).not.toContain('SECRET');
    await app.close();
  });

  it('rejects a key Delta refuses (nothing stored), and says to whitelist the IP when that is the reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { code: 'ip_not_whitelisted_for_api_key' } }), { status: 403 })));
    const app = await build();
    const owner = (await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'correct-horse' } })).json();
    const inv = (await app.inject({ method: 'POST', url: '/auth/invites', headers: bearer(owner.token), payload: {} })).json();
    const t = (await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: 'sam@example.com', password: 'a-long-password', displayName: 'Sam', inviteCode: inv.code } })).json().token;
    const r = await app.inject({ method: 'PUT', url: '/delta/credentials', headers: bearer(t), payload: { apiKey: 'SAM-KEY-12345678', apiSecret: 'SAM-SECRET-12345678' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/whitelist/i);
    expect((await app.inject({ method: 'GET', url: '/delta/credentials', headers: bearer(t) })).json().connected).toBe(false);
    await app.close();
  });

  it('the signed relay uses the caller\'s own key, refuses a user with none, and only reaches the read-only account paths', async () => {
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    const app = await build();
    const ravi = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ravi@example.com', password: 'a-long-password' } })).json().token;
    const sam = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'sam@example.com', password: 'a-long-password' } })).json().token;
    const ok = await app.inject({ method: 'GET', url: '/delta/signed?path=/v2/positions/margined&query=contract_types=call_options', headers: bearer(ravi) });
    expect(ok.statusCode).toBe(200);
    const call = f.mock.calls.at(-1) as any;
    expect(call[1].headers['api-key']).toBe('RAVI-KEY-123456'); // Ravi's key, decrypted in memory for this call
    expect(String(call[0])).toContain('/v2/positions/margined?contract_types=call_options');
    const none = await app.inject({ method: 'GET', url: '/delta/signed?path=/v2/positions/margined', headers: bearer(sam) });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('no_delta_key');
    const before = f.mock.calls.length;
    for (const bad of ['/v2/orders', '/v2/orders/batch', '/v2/products', '/v1/anything', '/v2/positions/../orders']) {
      expect((await app.inject({ method: 'GET', url: `/delta/signed?path=${encodeURIComponent(bad)}`, headers: bearer(ravi) })).statusCode).toBe(400);
    }
    expect(f.mock.calls.length).toBe(before); // nothing outside the allow-list went upstream
    expect((await app.inject({ method: 'GET', url: '/delta/signed?path=/v2/fills' })).statusCode).toBe(401);
    await app.close();
  });

  it('the owner falls back to the server key until a personal one is saved; a friend never does', async () => {
    process.env.DELTA_API_KEY = 'SERVER-KEY-0000';
    process.env.DELTA_API_SECRET = 'SERVER-SECRET-0000';
    const f = okFetch();
    vi.stubGlobal('fetch', f);
    const app = await build();
    const owner = (await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'correct-horse' } })).json().token;
    const sam = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'sam@example.com', password: 'a-long-password' } })).json().token;
    expect((await app.inject({ method: 'GET', url: '/delta/signed?path=/v2/fills', headers: bearer(owner) })).statusCode).toBe(200);
    expect((f.mock.calls.at(-1) as any)[1].headers['api-key']).toBe('SERVER-KEY-0000');
    expect((await app.inject({ method: 'GET', url: '/delta/signed?path=/v2/fills', headers: bearer(sam) })).statusCode).toBe(409);
    delete process.env.DELTA_API_KEY;
    delete process.env.DELTA_API_SECRET;
    await app.close();
  });

  it('removes a key on request, and refuses to store one when the master key is missing', async () => {
    const app = await build();
    const ravi = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'ravi@example.com', password: 'a-long-password' } })).json().token;
    expect((await app.inject({ method: 'DELETE', url: '/delta/credentials', headers: bearer(ravi) })).json().removed).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/delta/credentials', headers: bearer(ravi) })).json().connected).toBe(false);
    const keep = process.env.ENCRYPTION_MASTER_KEY;
    delete process.env.ENCRYPTION_MASTER_KEY;
    vi.stubGlobal('fetch', okFetch());
    const r = await app.inject({ method: 'PUT', url: '/delta/credentials', headers: bearer(ravi), payload: { apiKey: 'RAVI-KEY-123456', apiSecret: 'RAVI-SECRET-abcdef' } });
    expect(r.statusCode).toBe(503);
    expect((await pool.query('SELECT * FROM desk_delta_keys')).rows).toHaveLength(0);
    process.env.ENCRYPTION_MASTER_KEY = keep;
    await app.close();
  });
});
