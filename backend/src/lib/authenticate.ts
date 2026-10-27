import { tokenStillGood } from '../services/session-guard.js';

/**
 * The login check every protected route uses: the token must verify, and it must not pre-date the account's last password change
 * (a password reset ends the sign-ins made before it). Shared by the server and its tests, so the tests run the real check.
 */
export async function authenticate(request: any, reply: any): Promise<void> {
  try { await request.jwtVerify(); }
  catch { return reply.status(401).send({ success: false, error: 'Unauthorized' }); }
  if (!(await tokenStillGood(request))) return reply.status(401).send({ success: false, error: 'Your password was changed. Sign in again.' });
}
