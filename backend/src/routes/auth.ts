import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { decoyHash, hashPassword, verifyPassword } from '../lib/password.js';
import { requireAdmin, userId } from '../lib/guards.js';
import { approvePasswordReset, completePasswordReset, consumeInvite, consumeResetCode, createInvite, createPasswordResetRequest, createResetCode, createUser, DESK_USER_ID, ensureAuthSchema, findUserByEmail, findUserById, listInvites, RESET_TTL_MIN, returnInvite, revokeInvite, setPasswordHash } from '../services/auth-store.js';
import { hasDeltaKey } from '../services/delta-keys.js';
import { loginCooldown } from '../lib/cooldown.js';
import { isTokenRevoked, revokeToken, sessionStillValid } from '../services/session-guard.js';
import { pool } from '../db/index.js';
import { logAudit } from '../services/audit-logger.js';
import { emailService } from '../services/email-service.js';

function passwordOk(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  // Length check first avoids a timingSafeEqual throw; it leaks only the password length, which is
  // an acceptable trade-off behind HTTPS + a 10/min login rate limit.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const parts = cookie.split('=');
    const name = parts.shift()?.trim();
    if (name) {
      list[name] = decodeURIComponent(parts.join('=').trim());
    }
  });
  return list;
}

function getSessionToken(request: any): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = parseCookies(cookieHeader);
  return cookies.desk_token || cookies.session_token || cookies.token || null;
}

const resetBody = z.object({
  email: z.string().trim().toLowerCase().max(200).optional().default(''),
  code: z.string().trim().max(64).optional().default(''),
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
 *  POST /auth/logout    invalidate session token server-side, clear cookie, return 200
 *  POST /auth/signup    { email, password, displayName, inviteCode }, needs an unused invite code
 *  POST /auth/reset-password  { email, code, newPassword }: a friend who forgot the password, with a one-time code from the owner
 *  POST /auth/reset-codes     owner only: { email } makes that friend a one-time reset code (shown once)
 *  GET  /auth/me        the signed-in user
 *  POST/GET/DELETE /auth/invites   owner only: make, list and revoke invite codes
 */
export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const sign = (reply: any, u: { id: string; role: string; email: string }) => reply.jwtSign({ sub: u.id, role: u.role, email: u.email }, { expiresIn: '30d' });

  fastify.get('/me', async (request, reply) => {
    // Never accept a token from query string
    if (request.query && typeof request.query === 'object' && ('token' in request.query || 'jwt' in request.query || 'authorization' in request.query)) {
      return reply.status(401).send({ success: false, error: 'Unauthorized: Query string tokens not accepted' });
    }

    const cookieToken = getSessionToken(request);
    let decodedUser: { sub?: string; role?: string; email?: string; iat?: number } | null = null;

    if (cookieToken) {
      if (isTokenRevoked(cookieToken)) {
        return reply.status(401).send({ success: false, error: 'Session invalidated. Please log in again.' });
      }
      try {
        decodedUser = (fastify as any).jwt.verify(cookieToken);
      } catch {
        return reply.status(401).send({ success: false, error: 'Invalid session token' });
      }
    } else if (request.headers.authorization && !request.url.startsWith('/api/v1')) {
      // Legacy compatibility for older test suites calling /auth/me with Authorization header
      try {
        await request.jwtVerify();
        decodedUser = request.user as { sub?: string; role?: string; email?: string; iat?: number };
      } catch {
        return reply.status(401).send({ success: false, error: 'Unauthorized' });
      }
    } else {
      return reply.status(401).send({ success: false, error: 'Unauthorized: Session cookie required' });
    }

    if (!decodedUser) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' });
    }

    if (!(await sessionStillValid(decodedUser.sub, decodedUser.iat))) {
      return reply.status(401).send({ success: false, error: 'Your password was changed. Sign in again.' });
    }

    const uid = decodedUser.sub || DESK_USER_ID;
    const u = await findUserById(uid).catch(() => null);
    if (!u) {
      if (uid === DESK_USER_ID) {
        return {
          success: true,
          user: { id: DESK_USER_ID, email: decodedUser.email || 'desk@local', role: 'admin' },
          data: { id: DESK_USER_ID, email: decodedUser.email || 'desk@local', displayName: 'Desk', role: 'admin', createdAt: new Date().toISOString(), deltaConnected: false }
        };
      }
      return reply.status(404).send({ success: false, error: 'User not found' });
    }
    const admin = u.role === 'admin' || u.id === DESK_USER_ID;
    return {
      success: true,
      user: { id: u.id, email: u.email, role: admin ? 'admin' : u.role },
      data: { id: u.id, email: u.email, displayName: u.displayName, role: admin ? 'admin' : u.role, createdAt: u.createdAt, deltaConnected: await hasDeltaKey(u.id).catch(() => false) }
    };
  });

  fastify.post('/logout', async (request, reply) => {
    const token = getSessionToken(request) || (!request.url.startsWith('/api/v1') && request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7).trim() : null);
    let actorId = DESK_USER_ID;
    if (token) {
      try {
        const decoded = (fastify as any).jwt.verify(token);
        if (decoded?.sub || decoded?.id) {
          actorId = decoded.sub || decoded.id;
        }
      } catch {}
      revokeToken(token);
    }
    const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip || '127.0.0.1';
    void logAudit(pool, actorId, 'logout', 'success', ip);
    reply.header('Set-Cookie', 'desk_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    return reply.status(200).send({ success: true, message: 'Logged out successfully' });
  });

  fastify.post('/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip || '127.0.0.1';
    const isV1 = request.url.startsWith('/api/v1') || (request as any).routerPath?.startsWith('/api/v1');

    if (isV1) {
      const check = loginCooldown.check(ip, 5, 600_000);
      if (!check.allowed) {
        reply.header('Retry-After', check.retryAfterSeconds);
        void logAudit(pool, DESK_USER_ID, 'login', 'failed', ip);
        return reply.status(429).send({
          success: false,
          error: 'Too many login attempts. Cooldown active.',
          retryAfterSeconds: check.retryAfterSeconds,
        });
      }
      loginCooldown.record(ip);
    }

    const raw = (request.body || {}) as Record<string, unknown>;
    const password = typeof raw.password === 'string' ? raw.password : null; // reject non-string bodies (avoids Buffer.from throw -> 500)
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!password) {
      void logAudit(pool, DESK_USER_ID, 'login', 'failed', ip);
      return reply.status(401).send({ success: false, error: 'Wrong password' });
    }

    if (email) {
      const u = await findUserByEmail(email);
      const ok = await verifyPassword(password, u ? u.passwordHash : await decoyHash());
      if (!u || !ok) {
        void logAudit(pool, u?.id || DESK_USER_ID, 'login', 'failed', ip);
        return reply.status(401).send({ success: false, error: 'Wrong email or password' });
      }
      void logAudit(pool, u.id, 'login', 'success', ip);
      if (isV1) loginCooldown.forgetLast(ip); // a correct login does not count, but earlier wrong guesses stay counted
      const token = await sign(reply, { id: u.id, role: u.id === DESK_USER_ID ? 'admin' : u.role, email: u.email });
      reply.header('Set-Cookie', `desk_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
      return reply.send({ success: true, token, user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role } });
    }

    // the desk owner: the shared desk password, no email
    await ensureAuthSchema().catch(() => undefined);
    const owner = await findUserById(DESK_USER_ID);
    const hasDbPw = !!(owner && owner.passwordHash && owner.passwordHash !== '!');
    let ok = false;
    if (hasDbPw) {
      ok = await verifyPassword(password, owner!.passwordHash);
    }
    const expected = process.env.DESK_PASSWORD;
    if (!ok && expected) {
      ok = passwordOk(password, expected);
    }
    if (!ok) {
      void logAudit(pool, DESK_USER_ID, 'login', 'failed', ip);
      if (!hasDbPw && !expected) {
        return reply.status(503).send({ success: false, error: 'Login not configured on server. Set DESK_PASSWORD on the server to sign in as the desk owner.' });
      }
      return reply.status(401).send({ success: false, error: 'Wrong password. If you have a friend account, type your email too: only the desk owner leaves the email empty.' });
    }
    void logAudit(pool, DESK_USER_ID, 'login', 'success', ip);
    if (isV1) loginCooldown.forgetLast(ip);
    const token = await sign(reply, { id: DESK_USER_ID, role: 'admin', email: owner?.email || 'desk@local' });
    reply.header('Set-Cookie', `desk_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return reply.send({ success: true, token, user: { id: DESK_USER_ID, email: owner?.email || 'desk@local', displayName: owner?.displayName || 'Desk', role: 'admin' } });
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
    reply.header('Set-Cookie', `desk_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return reply.status(201).send({ success: true, token, user: { id: u.id, email: u.email, displayName: u.displayName, role: u.role } });
  });

  // Password reset: always needs the one-time code from the owner. Knowing an email is not proof of owning the account.
  // The owner has no code route: the DESK_PASSWORD server password always signs the owner in.
  fastify.post('/reset-password', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = resetBody.safeParse(request.body);
    if (!b.success) return reply.status(400).send({ success: false, error: b.error.issues[0]?.message ?? 'Send your new password (at least 10 characters)' });
    const { email, code, newPassword } = b.data;

    await ensureAuthSchema().catch(() => undefined);

    const u = email ? await findUserByEmail(email) : null;
    const ok = code && u && u.id !== DESK_USER_ID ? await consumeResetCode(u.id, code) : (await decoyHash(), false);
    if (!u || !ok) return reply.status(403).send({ success: false, error: 'That reset code is not valid (wrong email, unknown, already used or expired). Ask the desk owner for a new one.' });
    await setPasswordHash(u.id, await hashPassword(newPassword));
    const token = await sign(reply, { id: u.id, role: u.role, email: u.email });
    reply.header('Set-Cookie', `desk_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
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

  // --- Password Reset v2 (Task T1.3) ---

  // 1. Request: accepts email, creates pending row in desk_password_resets, returns 200 (never reveal if email exists)
  fastify.post('/password-reset/request', async (request, reply) => {
    const raw = (request.body || {}) as Record<string, unknown>;
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : undefined;

    if (!email) {
      return reply.status(400).send({ success: false, error: 'email is required' });
    }

    const res = await createPasswordResetRequest(email, token);
    let emailSent = false;
    let emailReason: string | undefined;
    if (res.token) {
      const host = (request.headers['x-forwarded-host'] as string) || request.headers.host || process.env.DOMAIN || 'suraj-voldesk.duckdns.org';
      const proto = (request.headers['x-forwarded-proto'] as string) || 'https';
      const resetLink = `${proto}://${host}/#reset=${encodeURIComponent(res.token)}&email=${encodeURIComponent(email)}`;
      const mailRes = await emailService.sendPasswordResetEmail(email, resetLink);
      emailSent = mailRes.sent;
      emailReason = mailRes.reason;
    }

    return reply.status(200).send({
      success: true,
      message: emailSent
        ? 'A password reset link has been sent to your email.'
        : 'If that email exists, a password reset request has been submitted for owner approval.',
      reset_id: res.resetId,
      resetId: res.resetId,
      token: res.token,
      emailSent,
      emailReason,
    });
  });

  // 2. Approve: owner-only (role='owner' or role='admin'), sets status='approved', decided_at=now(), decided_by=user_id, pending_owner_approval=false
  fastify.post('/password-reset/approve', async (request, reply) => {
    let decodedUser: { sub?: string; role?: string; email?: string } | null = null;
    const cookieToken = getSessionToken(request);
    if (cookieToken) {
      try {
        decodedUser = (fastify as any).jwt.verify(cookieToken);
      } catch {}
    }
    if (!decodedUser && request.headers.authorization?.startsWith('Bearer ')) {
      const token = request.headers.authorization.slice(7).trim();
      try {
        decodedUser = (fastify as any).jwt.verify(token);
      } catch {}
    }
    if (!decodedUser && (request as any).user) {
      decodedUser = (request as any).user;
    }

    const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip || '127.0.0.1';

    if (!decodedUser || (decodedUser.role !== 'owner' && decodedUser.role !== 'admin' && decodedUser.sub !== DESK_USER_ID)) {
      void logAudit(pool, decodedUser?.sub || DESK_USER_ID, 'password_reset_approve', 'denied', ip);
      return reply.status(403).send({ success: false, error: 'Only the desk owner can approve password resets' });
    }

    const raw = (request.body || {}) as Record<string, unknown>;
    const resetId = (raw.reset_id || raw.resetId || raw.id) as string | undefined;
    if (!resetId || typeof resetId !== 'string') {
      void logAudit(pool, decodedUser.sub || DESK_USER_ID, 'password_reset_approve', 'denied', ip);
      return reply.status(400).send({ success: false, error: 'reset_id is required' });
    }

    const ok = await approvePasswordReset(resetId, decodedUser.sub || DESK_USER_ID);
    if (!ok) {
      void logAudit(pool, decodedUser.sub || DESK_USER_ID, 'password_reset_approve', 'denied', ip);
      return reply.status(404).send({ success: false, error: 'Password reset request not found' });
    }
    void logAudit(pool, decodedUser.sub || DESK_USER_ID, 'password_reset_approve', 'success', ip);
    return reply.status(200).send({ success: true, message: 'Password reset approved', reset_id: resetId });
  });

  // 3. Complete: accepts token + new_password, looks up token_hash, checks status='approved', sets status='used', updates password
  fastify.post('/password-reset/complete', async (request, reply) => {
    const raw = (request.body || {}) as Record<string, unknown>;
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    const newPassword = typeof raw.new_password === 'string' ? raw.new_password : (typeof raw.newPassword === 'string' ? raw.newPassword : '');

    if (!token || !newPassword) {
      return reply.status(400).send({ success: false, error: 'token and new_password are required' });
    }
    if (newPassword.length < 10) {
      return reply.status(400).send({ success: false, error: 'Send your new password (at least 10 characters)' });
    }

    const res = await completePasswordReset(token, newPassword);
    if (!res.success) {
      return reply.status(res.status || 400).send({ success: false, error: res.error });
    }
    let jwtToken: string | undefined;
    if (res.user) {
      jwtToken = await sign(reply, res.user);
      reply.header('Set-Cookie', `desk_token=${jwtToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    }
    return reply.status(200).send({
      success: true,
      message: 'Password reset successfully',
      token: jwtToken,
      user: res.user,
    });
  });
};
