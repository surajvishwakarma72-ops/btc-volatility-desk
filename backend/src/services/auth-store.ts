import crypto from 'node:crypto';
import { pool } from '../db/index.js';

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
