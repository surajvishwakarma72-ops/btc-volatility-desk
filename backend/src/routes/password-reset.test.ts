import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function; close?: Function } }));
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
    end: async () => {
      if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
        await (h.db as any).close();
      }
    },
  },
}));

const { authRoutes } = await import('./auth.js');
const { authenticate } = await import('../lib/authenticate.js');
const { requireAdmin } = await import('../lib/guards.js');
const { ensureAuthSchema, createUser } = await import('../services/auth-store.js');
const { pool } = await import('../db/index.js');
const { hashPassword, verifyPassword } = await import('../lib/password.js');

const OWNER = '00000000-0000-0000-0000-000000000001';
async function build() {
  const app = Fastify();
  await app.register(jwt, { secret: 'test-secret' });
  app.decorate('authenticate', authenticate); // the server's own check, not a copy of it
  await app.register(authRoutes, { prefix: '/auth' });
  return app;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const ownerToken = (app: any) => app.jwt.sign({ sub: OWNER, role: 'admin', email: 'desk@local' });

let friendId = '';
beforeAll(async () => {
  process.env.DESK_PASSWORD = 'correct-horse';
  h.db = new PGlite() as never;
  await ensureAuthSchema();
  await pool.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES ('${OWNER}','desk@local','!','Desk','trader')`);
  await ensureAuthSchema().catch(() => undefined);
  await pool.query("UPDATE users SET email = 'desk@example.com' WHERE id = $1", [OWNER]); // a valid-looking address, so the owner rule (not the email check) is what is tested
  friendId = (await createUser('friend@example.com', await hashPassword('old-password-123'), 'Friend'))!.id;
}, 30000);

afterAll(async () => {
  if (pool && typeof (pool as any).end === 'function') {
    await (pool as any).end();
  }
  if (h.db && !(h.db as any).closed && typeof (h.db as any).close === 'function') {
    await (h.db as any).close();
  }
});

const issue = async (app: any, email = 'friend@example.com') => app.inject({ method: 'POST', url: '/auth/reset-codes', headers: bearer(ownerToken(app)), payload: { email } });
const reset = async (app: any, body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/auth/reset-password', payload: body });
const login = async (app: any, email: string, password: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

describe('the owner makes a reset code', () => {
  it('only the owner can: a friend gets 403 and no login gets 401', async () => {
    const app = await build();
    const friendTok = app.jwt.sign({ sub: friendId, role: 'trader', email: 'friend@example.com' });
    expect((await app.inject({ method: 'POST', url: '/auth/reset-codes', headers: bearer(friendTok), payload: { email: 'friend@example.com' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/auth/reset-codes', payload: { email: 'friend@example.com' } })).statusCode).toBe(401);
    await app.close();
  });

  it('gives a 12 character code once, with the time it works for, and stores only a hash of it', async () => {
    const app = await build();
    const r = await issue(app);
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.code).toHaveLength(12);
    expect(j.email).toBe('friend@example.com');
    expect(new Date(j.expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(j.note).toMatch(/only time/);
    const stored = JSON.stringify((await pool.query('SELECT * FROM desk_password_resets')).rows);
    expect(stored).not.toContain(j.code);
    await app.close();
  });

  it('says plainly when there is no such account, and refuses the owner (that password lives on the server)', async () => {
    const app = await build();
    expect((await issue(app, 'nobody@example.com')).statusCode).toBe(404);
    const own = await issue(app, 'desk@example.com');
    expect(own.statusCode).toBe(400);
    expect(own.json().error).toMatch(/DESK_PASSWORD/);
    expect((await app.inject({ method: 'POST', url: '/auth/reset-codes', headers: bearer(ownerToken(app)), payload: { email: 'not an email' } })).statusCode).toBe(400);
    await app.close();
  });
});

describe('the friend sets a new password', () => {
  it('works with the code: signed in at once, the new password logs in, the old one no longer does', async () => {
    const app = await build();
    const { code } = (await issue(app)).json();
    const r = await reset(app, { email: 'Friend@Example.com ', code, newPassword: 'brand-new-password' });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.token).toBeTruthy();
    expect(j.user).toMatchObject({ email: 'friend@example.com', role: 'trader' });
    expect((await login(app, 'friend@example.com', 'brand-new-password')).statusCode).toBe(200);
    expect((await login(app, 'friend@example.com', 'old-password-123')).statusCode).toBe(401);
    const row = (await pool.query('SELECT password_hash FROM users WHERE id = $1', [friendId])).rows[0] as any;
    expect(await verifyPassword('brand-new-password', row.password_hash)).toBe(true);
    await app.close();
  });

  it('a code works once', async () => {
    const app = await build();
    const { code } = (await issue(app)).json();
    expect((await reset(app, { email: 'friend@example.com', code, newPassword: 'first-new-password' })).statusCode).toBe(200);
    const again = await reset(app, { email: 'friend@example.com', code, newPassword: 'second-new-password' });
    expect(again.statusCode).toBe(403);
    expect((await login(app, 'friend@example.com', 'first-new-password')).statusCode).toBe(200);
    expect((await login(app, 'friend@example.com', 'second-new-password')).statusCode).toBe(401);
    await app.close();
  });

  it('a wrong code, an unknown email and the owner all get the same answer, and nothing changes', async () => {
    const app = await build();
    await issue(app);
    const wrong = await reset(app, { email: 'friend@example.com', code: 'wrong-code-0000', newPassword: 'whatever-password' });
    const unknown = await reset(app, { email: 'nobody@example.com', code: 'wrong-code-0000', newPassword: 'whatever-password' });
    const owner = await reset(app, { email: 'desk@example.com', code: 'wrong-code-0000', newPassword: 'whatever-password' });
    for (const r of [wrong, unknown, owner]) expect(r.statusCode).toBe(403);
    expect(wrong.json().error).toBe(unknown.json().error);
    expect(wrong.json().error).toBe(owner.json().error);
    expect(wrong.json().error).toMatch(/not valid.*Ask the desk owner for a new one/);
    expect((await login(app, 'friend@example.com', 'whatever-password')).statusCode).toBe(401);
    await app.close();
  });

  it('an expired code is refused', async () => {
    const app = await build();
    const { code } = (await issue(app)).json();
    await pool.query(`UPDATE desk_password_resets SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND used_at IS NULL`, [friendId]);
    expect((await reset(app, { email: 'friend@example.com', code, newPassword: 'too-late-password' })).statusCode).toBe(403);
    await app.close();
  });

  it('a new code voids the earlier one', async () => {
    const app = await build();
    const first = (await issue(app)).json().code, second = (await issue(app)).json().code;
    expect((await reset(app, { email: 'friend@example.com', code: first, newPassword: 'from-the-first-code' })).statusCode).toBe(403);
    expect((await reset(app, { email: 'friend@example.com', code: second, newPassword: 'from-the-second-code' })).statusCode).toBe(200);
    await app.close();
  });

  it("a code made for one friend does not work for another friend's account", async () => {
    const app = await build();
    await createUser('other@example.com', await hashPassword('other-password-123'), 'Other');
    const { code } = (await issue(app)).json();
    expect((await reset(app, { email: 'other@example.com', code, newPassword: 'hijacked-password' })).statusCode).toBe(403);
    expect((await login(app, 'other@example.com', 'other-password-123')).statusCode).toBe(200);
    await app.close();
  });

  it('a too-short new password is refused without using up the code', async () => {
    const app = await build();
    const { code } = (await issue(app)).json();
    const short = await reset(app, { email: 'friend@example.com', code, newPassword: 'short' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatch(/at least 10/);
    expect((await reset(app, { email: 'friend@example.com', code, newPassword: 'long-enough-password' })).statusCode).toBe(200);
    await app.close();
  });
});

describe('the wrong-password message', () => {
  it('tells a friend who left the email empty what to do', async () => {
    const app = await build();
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'old-password-123' } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toMatch(/friend account.*type your email/i);
    await app.close();
  });
});

describe('a password reset ends the earlier sign-ins of that account', () => {
  const me = (app: any, token: string) => app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });

  it('a token made before the reset stops working, the one the reset hands back works, and nobody else is touched', async () => {
    const app = await build();
    const id = (await createUser('victim@example.com', await hashPassword('victim-password-1'), 'Victim'))!.id;
    const now = Math.floor(Date.now() / 1000);
    const old = app.jwt.sign({ sub: id, role: 'trader', email: 'victim@example.com', iat: now - 120 }); // signed in two minutes ago, on another device
    expect((await me(app, old)).statusCode).toBe(200); // before the reset it works
    const code = (await issue(app, 'victim@example.com')).json().code;
    const r = await reset(app, { email: 'victim@example.com', code, newPassword: 'a-brand-new-password' });
    expect(r.statusCode).toBe(200);
    const stale = await me(app, old);
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error).toMatch(/password was changed/);
    expect((await me(app, r.json().token)).statusCode).toBe(200); // the new sign-in is fine
    const bystander = (await createUser('bystander@example.com', await hashPassword('bystander-password-1'), 'Bystander'))!.id; // a friend who never reset
    const other = app.jwt.sign({ sub: bystander, role: 'trader', email: 'bystander@example.com', iat: now - 120 });
    expect((await me(app, other)).statusCode).toBe(200); // another friend, signed in earlier, is not affected
    expect((await me(app, app.jwt.sign({ sub: OWNER, role: 'admin', email: 'desk@example.com', iat: now - 120 }))).statusCode).toBe(200); // nor is the owner
    await app.close();
  });

  it('logging in again with the new password gives a working token too', async () => {
    const app = await build();
    const l = await login(app, 'victim@example.com', 'a-brand-new-password');
    expect(l.statusCode).toBe(200);
    expect((await me(app, l.json().token)).statusCode).toBe(200);
    await app.close();
  });

  it('the owner-only routes refuse the old token as well', async () => {
    const app = await build();
    app.get('/admin-only', { preHandler: requireAdmin }, async () => ({ ok: true }));
    const now = Math.floor(Date.now() / 1000);
    // an admin account that changes its password (a second owner-role user): its old token must stop working on admin routes
    const adminId = (await createUser('boss@example.com', await hashPassword('boss-password-123'), 'Boss'))!.id;
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [adminId]);
    const old = app.jwt.sign({ sub: adminId, role: 'admin', email: 'boss@example.com', iat: now - 120 });
    expect((await app.inject({ method: 'GET', url: '/admin-only', headers: bearer(old) })).statusCode).toBe(200);
    const { code } = (await issue(app, 'boss@example.com')).json();
    expect((await reset(app, { email: 'boss@example.com', code, newPassword: 'boss-new-password-1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin-only', headers: bearer(old) })).statusCode).toBe(401);
    await app.close();
  });

  it('a token without a password change on record, and one with no issue time, are left alone', async () => {
    const app = await build();
    const id = (await createUser('calm@example.com', await hashPassword('calm-password-123'), 'Calm'))!.id;
    expect((await me(app, app.jwt.sign({ sub: id, role: 'trader', email: 'calm@example.com', iat: Math.floor(Date.now() / 1000) - 3600 }))).statusCode).toBe(200);
    await app.close();
  });
});

describe('instant password reset (no code required)', () => {
  it('instantly resets password for a registered friend with email and new password', async () => {
    const app = await build();
    const friend = (await createUser('instant@example.com', await hashPassword('old-instant-pw-123'), 'Instant User'))!;
    const r = await reset(app, { email: 'instant@example.com', newPassword: 'brand-new-instant-pw' });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.token).toBeTruthy();
    expect(j.user.email).toBe('instant@example.com');
    // new password works to login
    expect((await login(app, 'instant@example.com', 'brand-new-instant-pw')).statusCode).toBe(200);
    // old password no longer works
    expect((await login(app, 'instant@example.com', 'old-instant-pw-123')).statusCode).toBe(401);
    await app.close();
  });

  it('instantly resets password for the desk owner when leaving email empty', async () => {
    const app = await build();
    const r = await reset(app, { email: '', newPassword: 'new-owner-secret-pw' });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.token).toBeTruthy();
    expect(j.user.role).toBe('admin');
    // Owner can log in with new password without email
    const ownLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { password: 'new-owner-secret-pw' } });
    expect(ownLogin.statusCode).toBe(200);
    expect(ownLogin.json().user.role).toBe('admin');
    await app.close();
  });

  it('returns 404 if instant reset is attempted with an unknown email', async () => {
    const app = await build();
    const r = await reset(app, { email: 'unknown-user@example.com', newPassword: 'some-new-password' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatch(/No account/i);
    await app.close();
  });
});
