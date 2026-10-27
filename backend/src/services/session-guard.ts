import { pool } from '../db/index.js';
import { ensureAuthSchema } from './auth-store.js';

/**
 * A password reset ends every earlier sign-in of that account. A token carries the second it was issued (iat); an account that changed its
 * password at some moment (users.password_changed_at) refuses any token issued in an earlier second. The new token a reset hands back is
 * issued after the change, so it stays valid. Accounts that never reset (and the owner, whose password is set on the server) are never
 * affected. The moment is cached for a minute so a page load that makes a hundred calls costs one lookup, and a reset updates the cache
 * at once. If the lookup itself fails, the token is accepted: a database blip must not sign everyone out.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; changedMs: number | null }>();

/** Called by a password change, so this server stops accepting the old tokens straight away instead of after the cache expires. */
export function noteSessionReset(userId: string, changedMs: number): void {
  cache.set(userId, { at: Date.now(), changedMs });
}

export function resetSessionGuardCache(): void { cache.clear(); }

async function changedAt(userId: string): Promise<number | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.changedMs;
  await ensureAuthSchema();
  const r = await pool.query('SELECT password_changed_at FROM users WHERE id = $1', [userId]);
  const v = (r.rows[0] as { password_changed_at?: string | Date | null } | undefined)?.password_changed_at;
  const changedMs = v ? new Date(v).getTime() : null;
  cache.set(userId, { at: Date.now(), changedMs });
  return changedMs;
}

/** True when the token (issued at `iatSec`, in seconds) is still good for this user. A token without an issue time is judged as issued now. */
export async function sessionStillValid(userId: string | undefined, iatSec: number | undefined): Promise<boolean> {
  if (!userId || typeof iatSec !== 'number') return true;
  try {
    const ch = await changedAt(userId);
    return ch == null || iatSec >= Math.floor(ch / 1000);
  } catch {
    return true;
  }
}

/** Used by every place that verifies a login token: false means "sign in again". */
export async function tokenStillGood(request: { user?: unknown }): Promise<boolean> {
  const u = request.user as { sub?: string; iat?: number } | undefined;
  return sessionStillValid(u?.sub, u?.iat);
}
