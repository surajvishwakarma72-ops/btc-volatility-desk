import crypto from 'node:crypto';
import { pool } from '../db/index.js';
import { noteSessionReset } from './session-guard.js';
import { hashPassword } from '../lib/password.js';

/**
 * Accounts, invite codes and each user's stored Delta key. Created idempotently like the paper and bot tables, so a
 * deploy needs no separate migration. `users` already exists in production; the CREATE only matters on a fresh database.
 */
export const DESK_USER_ID = '00000000-0000-0000-0000-000000000001';

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(255) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name varchar(100),
  role varchar(20) NOT NULL DEFAULT 'trader',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
CREATE TABLE IF NOT EXISTS desk_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '',
  max_uses integer NOT NULL DEFAULT 1,
  uses integer NOT NULL DEFAULT 0,
  revoked boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS desk_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code_hash text,
  expires_at timestamptz,
  used_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  token_hash text,
  status varchar(20) NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id),
  pending_owner_approval boolean NOT NULL DEFAULT true
);
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'pending';
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id);
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS pending_owner_approval boolean NOT NULL DEFAULT true;
ALTER TABLE desk_password_resets ALTER COLUMN code_hash DROP NOT NULL;
ALTER TABLE desk_password_resets ALTER COLUMN expires_at DROP NOT NULL;
CREATE INDEX IF NOT EXISTS desk_password_resets_user_idx ON desk_password_resets (user_id);
CREATE INDEX IF NOT EXISTS idx_pwreset_token ON desk_password_resets(token_hash) WHERE token_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS desk_delta_keys (
  user_id uuid PRIMARY KEY,
  key_enc text NOT NULL,
  key_salt text NOT NULL,
  key_iv text NOT NULL,
  key_tag text NOT NULL,
  secret_enc text NOT NULL,
  secret_salt text NOT NULL,
  secret_iv text NOT NULL,
  secret_tag text NOT NULL,
  key_last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  last_error text
);
`;

let ready: Promise<void> | null = null;
export function ensureAuthSchema(): Promise<void> {
  if (!ready) {
    ready = pool.query(DDL).then(() => pool.query(`UPDATE users SET role = 'admin' WHERE id = $1 AND role <> 'admin'`, [DESK_USER_ID])).then(() => undefined);
    ready.catch(() => { ready = null; });
  }
  return ready;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  passwordHash: string;
  createdAt: string;
}
const mapUser = (r: any): UserRow => ({ id: r.id, email: r.email, displayName: r.display_name ?? null, role: r.role, passwordHash: r.password_hash, createdAt: new Date(r.created_at).toISOString() });

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  await ensureAuthSchema();
  const r = await pool.query('SELECT * FROM users WHERE lower(email) = $1 LIMIT 1', [email.toLowerCase()]);
  return r.rows[0] ? mapUser(r.rows[0]) : null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  await ensureAuthSchema();
  const r = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return r.rows[0] ? mapUser(r.rows[0]) : null;
}

const hashCode = (code: string): string => crypto.createHash('sha256').update(code.trim()).digest('hex');

export async function createInvite(label: string, maxUses: number, createdBy: string): Promise<{ id: string; code: string }> {
  await ensureAuthSchema();
  const code = crypto.randomBytes(9).toString('base64url'); // 12 characters, shown once
  const r = await pool.query('INSERT INTO desk_invites (code_hash, label, max_uses, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [hashCode(code), label.slice(0, 80), maxUses, createdBy]);
  return { id: (r.rows[0] as any).id, code };
}

export async function listInvites() {
  await ensureAuthSchema();
  const r = await pool.query('SELECT id, label, max_uses, uses, revoked, created_at FROM desk_invites ORDER BY created_at DESC LIMIT 100');
  return (r.rows as any[]).map((x) => ({ id: x.id as string, label: x.label as string, maxUses: Number(x.max_uses), uses: Number(x.uses), revoked: !!x.revoked, createdAt: new Date(x.created_at).toISOString() }));
}

export async function revokeInvite(id: string): Promise<boolean> {
  await ensureAuthSchema();
  const r = await pool.query('UPDATE desk_invites SET revoked = true WHERE id = $1 AND NOT revoked RETURNING id', [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Use up one use of an invite in a single atomic statement; false if the code is unknown, revoked or used up. */
export async function consumeInvite(code: string): Promise<boolean> {
  await ensureAuthSchema();
  const r = await pool.query('UPDATE desk_invites SET uses = uses + 1 WHERE code_hash = $1 AND NOT revoked AND uses < max_uses RETURNING id', [hashCode(code)]);
  return (r.rowCount ?? 0) > 0;
}

export async function returnInvite(code: string): Promise<void> {
  await pool.query('UPDATE desk_invites SET uses = GREATEST(uses - 1, 0) WHERE code_hash = $1', [hashCode(code)]);
}

export async function createUser(email: string, passwordHash: string, displayName: string): Promise<UserRow | null> {
  await ensureAuthSchema();
  try {
    const r = await pool.query(`INSERT INTO users (email, password_hash, display_name, role) VALUES ($1,$2,$3,'trader') RETURNING *`, [email.toLowerCase(), passwordHash, displayName.slice(0, 100)]);
    return mapUser(r.rows[0]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') return null; // the email is already registered
    throw e;
  }
}

/** How long a reset code works. */
export const RESET_TTL_MIN = 60;

/**
 * A one-time password reset code for a friend, made by the owner (there is no email service to send a link). Only a hash is stored, the
 * code is shown once, it works once, and it expires. A new code voids the earlier ones for the same person.
 */
export async function createResetCode(userId: string, createdBy: string): Promise<{ code: string; expiresAt: string }> {
  await ensureAuthSchema();
  await pool.query('UPDATE desk_password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const code = crypto.randomBytes(9).toString('base64url'); // 12 characters, 72 bits
  const r = await pool.query(`INSERT INTO desk_password_resets (user_id, code_hash, expires_at, created_by) VALUES ($1,$2, now() + interval '${RESET_TTL_MIN} minutes', $3) RETURNING expires_at`, [userId, hashCode(code), createdBy]);
  return { code, expiresAt: new Date((r.rows[0] as any).expires_at).toISOString() };
}

/** Use the code in one atomic statement: true only if it is this person's, unused and not expired. */
export async function consumeResetCode(userId: string, code: string): Promise<boolean> {
  await ensureAuthSchema();
  const r = await pool.query('UPDATE desk_password_resets SET used_at = now(), status = \'used\' WHERE user_id = $1 AND (code_hash = $2 OR token_hash = $3) AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now()) RETURNING id', [userId, hashCode(code.trim()), crypto.createHash('sha256').update(code.trim()).digest('hex')]);
  return (r.rowCount ?? 0) > 0;
}

export async function setPasswordHash(userId: string, passwordHash: string): Promise<void> {
  await ensureAuthSchema();
  if (userId === DESK_USER_ID) {
    await pool.query(`
      INSERT INTO users (id, email, password_hash, display_name, role)
      VALUES ($1, 'desk@local', $2, 'Desk', 'admin')
      ON CONFLICT (id) DO UPDATE SET password_hash = $2, updated_at = now(), password_changed_at = now()
    `, [userId, passwordHash]);
    noteSessionReset(userId, Date.now());
    return;
  }
  const r = await pool.query('UPDATE users SET password_hash = $2, updated_at = now(), password_changed_at = now() WHERE id = $1 RETURNING password_changed_at', [userId, passwordHash]);
  // every token issued before this moment stops working (see session-guard.ts)
  noteSessionReset(userId, r.rows[0] ? new Date((r.rows[0] as any).password_changed_at).getTime() : Date.now());
}

export async function createPasswordResetRequest(email: string, clientToken?: string): Promise<{ success: boolean; resetId?: string; token?: string }> {
  await ensureAuthSchema();
  const u = await findUserByEmail(email);
  if (!u) {
    return { success: true };
  }
  const token = clientToken || crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
  const r = await pool.query(
    `INSERT INTO desk_password_resets (user_id, token_hash, status, requested_at, pending_owner_approval, expires_at)
     VALUES ($1, $2, 'pending', now(), true, now() + interval '30 minutes')
     RETURNING id`,
    [u.id, tokenHash]
  );
  return { success: true, resetId: (r.rows[0] as any).id, token };
}

export async function approvePasswordReset(resetId: string, decidedBy: string): Promise<boolean> {
  await ensureAuthSchema();
  const r = await pool.query(
    `UPDATE desk_password_resets
     SET status = 'approved', decided_at = now(), decided_by = $1, pending_owner_approval = false
     WHERE id = $2
     RETURNING id`,
    [decidedBy, resetId]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function completePasswordReset(token: string, newPassword: string): Promise<{ success: boolean; status?: number; error?: string; user?: any }> {
  await ensureAuthSchema();
  const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
  const r = await pool.query(
    `SELECT * FROM desk_password_resets WHERE token_hash = $1 ORDER BY requested_at DESC LIMIT 1`,
    [tokenHash]
  );
  const row = r.rows[0];
  if (!row) {
    return { success: false, status: 404, error: 'Invalid or unknown reset token' };
  }
  if (row.status === 'used') {
    return { success: false, status: 410, error: 'This reset token has already been used' };
  }
  if (row.status !== 'approved') {
    return { success: false, status: 400, error: 'This reset request is still pending owner approval' };
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { success: false, status: 410, error: 'This reset token has expired' };
  }

  await pool.query(`UPDATE desk_password_resets SET status = 'used', used_at = now() WHERE id = $1`, [row.id]);
  await setPasswordHash(row.user_id, await hashPassword(newPassword));
  const u = await findUserById(row.user_id);
  return { success: true, user: u ? { id: u.id, email: u.email, displayName: u.displayName, role: u.role } : undefined };
}
