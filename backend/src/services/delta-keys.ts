import { pool } from '../db/index.js';
import { open, seal } from '../lib/crypto.js';
import { ensureAuthSchema } from './auth-store.js';

/**
 * Each user's Delta API keys, stored encrypted (AES-256-GCM). Reads return status only; decrypting happens in memory per request.
 * Two separate slots: the READ key (positions and fills, shown on the P&L pages and watched by the alarm) and the TRADE key, which is
 * only ever used by the opt-in hard exit to send reduce-only closing orders. Keeping them apart means a friend who only wants to watch
 * never has to give the desk a key that can trade.
 */
export type KeyKind = 'read' | 'trade';
const table = (k: KeyKind): string => (k === 'trade' ? 'desk_delta_trade_keys' : 'desk_delta_keys');

async function ready(kind: KeyKind): Promise<void> {
  await ensureAuthSchema();
  if (kind === 'trade') {
    const { ensureWatchSchema } = await import('./watch/watch-store.js');
    await ensureWatchSchema();
  }
}

export async function hasDeltaKey(userId: string, kind: KeyKind = 'read'): Promise<boolean> {
  await ready(kind);
  const r = await pool.query(`SELECT 1 FROM ${table(kind)} WHERE user_id = $1`, [userId]);
  return r.rows.length > 0;
}

export async function deltaKeyStatus(userId: string, kind: KeyKind = 'read') {
  await ready(kind);
  const r = await pool.query(`SELECT key_last4, updated_at, last_ok_at, last_error FROM ${table(kind)} WHERE user_id = $1`, [userId]);
  const x = r.rows[0] as any;
  if (!x) return { connected: false as const };
  return { connected: true as const, keyLast4: x.key_last4 as string, savedAt: new Date(x.updated_at).toISOString(), lastOkAt: x.last_ok_at ? new Date(x.last_ok_at).toISOString() : null, lastError: (x.last_error ?? null) as string | null };
}

export async function saveDeltaKey(userId: string, apiKey: string, apiSecret: string, kind: KeyKind = 'read'): Promise<void> {
  await ready(kind);
  const k = seal(apiKey), s = seal(apiSecret);
  await pool.query(
    `INSERT INTO ${table(kind)} (user_id, key_enc, key_salt, key_iv, key_tag, secret_enc, secret_salt, secret_iv, secret_tag, key_last4, last_ok_at, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), NULL)
     ON CONFLICT (user_id) DO UPDATE SET key_enc=$2, key_salt=$3, key_iv=$4, key_tag=$5, secret_enc=$6, secret_salt=$7, secret_iv=$8, secret_tag=$9, key_last4=$10, updated_at=now(), last_ok_at=now(), last_error=NULL`,
    [userId, k.data, k.salt, k.iv, k.tag, s.data, s.salt, s.iv, s.tag, apiKey.slice(-4)],
  );
}

export async function deleteDeltaKey(userId: string, kind: KeyKind = 'read'): Promise<boolean> {
  await ready(kind);
  const r = await pool.query(`DELETE FROM ${table(kind)} WHERE user_id = $1 RETURNING user_id`, [userId]);
  return (r.rowCount ?? 0) > 0;
}

/** The decrypted pair, for signing one request. Returns null when nothing is saved. Throws if the data was tampered with. */
export async function loadDeltaKey(userId: string, kind: KeyKind = 'read'): Promise<{ key: string; secret: string } | null> {
  await ready(kind);
  const r = await pool.query(`SELECT * FROM ${table(kind)} WHERE user_id = $1`, [userId]);
  const x = r.rows[0] as any;
  if (!x) return null;
  return {
    key: open({ data: x.key_enc, salt: x.key_salt, iv: x.key_iv, tag: x.key_tag }),
    secret: open({ data: x.secret_enc, salt: x.secret_salt, iv: x.secret_iv, tag: x.secret_tag }),
  };
}

/** The only key an order may be signed with. Comes from the trade slot alone, so a read-only key can never reach an order call. */
export function loadOrderKey(userId: string): Promise<{ key: string; secret: string } | null> {
  return loadDeltaKey(userId, 'trade');
}

export async function noteDeltaResult(userId: string, ok: boolean, error: string | null, kind: KeyKind = 'read'): Promise<void> {
  await pool.query(
    ok ? `UPDATE ${table(kind)} SET last_ok_at = now(), last_error = NULL WHERE user_id = $1` : `UPDATE ${table(kind)} SET last_error = $2 WHERE user_id = $1`,
    ok ? [userId] : [userId, (error ?? 'failed').slice(0, 300)],
  ).catch(() => undefined);
}

/** Every user who has saved a read key (the alarm watches their real positions). */
export async function usersWithDeltaKey(): Promise<string[]> {
  await ready('read');
  const r = await pool.query('SELECT user_id FROM desk_delta_keys');
  return (r.rows as Array<{ user_id: string }>).map((x) => x.user_id);
}
