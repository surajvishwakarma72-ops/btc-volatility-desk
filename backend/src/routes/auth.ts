import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { decoyHash, hashPassword, verifyPassword } from '../lib/password.js';
import { requireAdmin, userId } from '../lib/guards.js';
import { consumeInvite, consumeResetCode, createInvite, createResetCode, createUser, DESK_USER_ID, ensureAuthSchema, findUserByEmail, findUserById, listInvites, RESET_TTL_MIN, returnInvite, revokeInvite, setPasswordHash } from '../services/auth-store.js';
import { hasDeltaKey } from '../services/delta-keys.js';

function passwordOk(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  // Length check first avoids a timingSafeEqual throw; it leaks only the password length, which is
  // an acceptable trade-off behind HTTPS + a 10/min login rate limit.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const resetBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  code: z.string().trim().min(4).max(64),
  newPassword: z.string().min(10, 'password must be at least 10 characters').max(200),
});

const signupBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10, 'password must be at least 10 characters').max(200),
  displayName: z.string().trim().min(1).max(60),
  inviteCode: z.string().trim().min(4).max(64),
});

/**
 * Authentication & profile routes.
 *  POST /auth/login     { email, password } for a friend, or just { password } for the desk owner (the shared desk password)
 *  POST /auth/signup    { email, password, displayName, inviteCode }, needs an unused invite code
 *  POST /auth/reset-password  { email, code, newPassword }: a friend who forgot the password, with a one-time code from the owner
 *  POST /auth/reset-codes     owner only: { email } makes that friend a one-time reset code (shown once)
 *  GET  /auth/me        the signed-in user
 *  POST/GET/DELETE /auth/invites   owner only: make, list and revoke invite codes
 */
export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate ?? (async (req: any, reply: any) => { try { await req.jwtVerify(); } catch { reply.status(401).send({ success: false, error: 'Unauthorized' }); } }) };
  const sign = (reply: any, u: { id: string; role: string; email: string }) => reply.jwtSign({ sub: u.id, role: u.role, email: u.email }, { expiresIn: '30d' });

  fastify.get('/me', auth, async (request, reply) => {
    const u = await findUserById(userId(request));
    if (!u) return reply.status(404).send({ success: false, error: 'User not found' });
    const admin = u.role === 'admin' || u.id === DESK_USER_ID;
    return { success: true, data: { id: u.id, email: u.email, displayName: u.displayName, role: admin ? 'admin' : u.role, createdAt: u.createdAt, deltaConnected: await hasDeltaKey(u.id).catch(() => false) } };
  });

  fastify.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const raw = (request.body || {}) as Record<string, unknown>;
    const password = typeof raw.password === 'string' ? raw.password : null; // reject non-string bodies (avoids Buffer.from throw -> 500)
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!password) return reply.status(401).send({ success: false, error: 'Wrong password' });

    if (email) {
      const u = await findUserByEmail(email);
      const ok = await verifyPassword(password, u ? u.passwordHash : await decoyHash());
      if (!u || !ok) return reply.status(401).send({ success: false, error: 'Wrong email or password' });
      const token = await sign(reply, { id: u.id, role: u.id === DESK_USER_ID ? 'admin' : u.role, email: u.email });
      return reply.send({ success: true, token, user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role } });
    }

    // the desk owner: the shared desk password, no email
    const expected = process.env.DESK_PASSWORD;
    if (!expected) return reply.status(503).send({ success: false, error: 'Login not configured on server' });
    if (!passwordOk(password, expected)) return reply.status(401).send({ success: false, error: 'Wrong password. If you have a friend account, type your email too: only the desk owner leaves the email empty.' });
    await ensureAuthSchema().catch(() => undefined);
    const token = await sign(reply, { id: DESK_USER_ID, role: 'admin', email: 'desk@local' });
    return reply.send({ success: true, token, user: { id: DESK_USER_ID, email: 'desk@local', displayName: 'Desk', role: 'admin' } });
  });

  fastify.post('/signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = signupBody.safeParse(request.body);
    if (!b.success) return reply.status(400).send({ success: false, error: b.error.issues[0]?.message ?? 'invalid sign-up details' });
    const { email, password, displayName, inviteCode } = b.data;
    // the invite is checked first, so a stranger without one learns nothing about which emails have accounts
    if (!(await consumeInvite(inviteCode))) return reply.status(403).send({ success: false, error: 'That invite code is not valid (unknown, used up or revoked)' });
    if (await findUserByEmail(email)) {
      await returnInvite(inviteCode);
      return reply.status(409).send({ success: false, error: 'That email already has an account' });
    }
    const u = await createUser(email, await hashPassword(password), displayName);
    if (!u) {
      await returnInvite(inviteCode); // lost a race on the same email: give the use back
      return reply.status(409).send({ success: false, error: 'That email already has an account' });
    }
    const token = await sign(reply, { id: u.id, role: u.role, email: u.email });
    return reply.status(201).send({ success: true, token, user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role } });
  });

  // a friend who forgot the password: the owner makes a one-time code, the friend sets a new password with it and is signed in
  fastify.post('/reset-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = resetBody.safeParse(request.body);
    if (!b.success) return reply.status(400).send({ success: false, error: b.error.issues[0]?.message ?? 'send your email, the reset code and a new password' });
    const { email, code, newPassword } = b.data;
    const u = await findUserByEmail(email);
    // one answer for an unknown email, a wrong code, a used code and an expired code: nothing tells a stranger which emails have accounts
    const ok = u && u.id !== DESK_USER_ID ? await consumeResetCode(u.id, code) : (await decoyHash(), false);
    if (!u || !ok) return reply.status(403).send({ success: false, error: 'That reset code is not valid (wrong email, unknown, already used or expired). Ask the desk owner for a new one.' });
    await setPasswordHash(u.id, await hashPassword(newPassword));
    const token = await sign(reply, { id: u.id, role: u.role, email: u.email });
    return reply.send({ success: true, token, user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role } });
  });

  // owner only: invite codes for friends
  const admin = { preHandler: requireAdmin };
  fastify.post('/invites', admin, async (request, reply) => {
    const b = z.object({ label: z.string().trim().max(80).optional(), maxUses: z.number().int().min(1).max(100).optional() }).safeParse(request.body ?? {});
    if (!b.success) return reply.status(400).send({ success: false, error: 'label is text, maxUses is 1 to 100' });
    const r = await createInvite(b.data.label ?? '', b.data.maxUses ?? 1, userId(request));
    return reply.status(201).send({ success: true, id: r.id, code: r.code, note: 'This is the only time the code is shown.' });
  });
  fastify.get('/invites', admin, async () => ({ success: true, invites: await listInvites() }));
  fastify.post('/reset-codes', { ...admin, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = z.object({ email: z.string().trim().toLowerCase().email().max(200) }).safeParse(request.body ?? {});
    if (!b.success) return reply.status(400).send({ success: false, error: "send the friend's email" });
    const u = await findUserByEmail(b.data.email);
    if (!u) return reply.status(404).send({ success: false, error: 'No account has that email. Check the spelling, or send them an invite code to create one.' });
    if (u.id === DESK_USER_ID) return reply.status(400).send({ success: false, error: 'The desk owner password is set on the server (DESK_PASSWORD), not here.' });
    const r = await createResetCode(u.id, userId(request));
    return reply.status(201).send({ success: true, code: r.code, email: u.email, name: u.displayName, expiresAt: r.expiresAt, note: `This is the only time the code is shown. It works once, for ${RESET_TTL_MIN} minutes. Your friend presses "Forgot password?" on the sign-in window.` });
  });
  fastify.delete('/invites/:id', admin, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(400).send({ success: false, error: 'invalid id' });
    return (await revokeInvite(id)) ? { success: true } : reply.status(404).send({ success: false, error: 'no active invite with that id' });
  });
};
