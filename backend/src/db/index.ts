import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import net from 'node:net';
import pg from 'pg';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL;

let normalizedConnectionString = connectionString;
if (normalizedConnectionString && normalizedConnectionString.includes('sslmode=require') && !normalizedConnectionString.includes('uselibpqcompat')) {
  normalizedConnectionString = normalizedConnectionString.replace('sslmode=require', 'sslmode=require&uselibpqcompat=true');
}

const isSupabase = !!normalizedConnectionString &&
  (normalizedConnectionString.includes('supabase.co') ||
   normalizedConnectionString.includes('supabase.com') ||
   normalizedConnectionString.includes('pooler.supabase.com'));

const needsSsl = !!normalizedConnectionString &&
  (normalizedConnectionString.includes('neon.tech') ||
   isSupabase ||
   normalizedConnectionString.includes('sslmode=require'));

// Give connection attempts room, keep sockets alive and keep a few warm.
try { (net as unknown as { setDefaultAutoSelectFamilyAttemptTimeout?: (ms: number) => void }).setDefaultAutoSelectFamilyAttemptTimeout?.(10_000); } catch { /* older Node */ }

const rejectUnauthorized = process.env.DATABASE_REJECT_UNAUTHORIZED === 'true'
  ? true
  : isSupabase
    ? false
    : !normalizedConnectionString?.includes('neon.tech');

export const pool = new pg.Pool({
  connectionString: normalizedConnectionString,
  max: 10,
  connectionTimeoutMillis: 20_000,
  idleTimeoutMillis: 600_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: needsSsl
    ? { rejectUnauthorized, ca: process.env.DATABASE_CA || undefined }
    : undefined,
});

// an idle connection that the server dropped must not crash the process
pool.on('error', (e) => console.error('[db] idle connection error:', (e as Error).message));

/** True when the connection itself could not be made, so nothing ran and the statement is safe to send again. */
export function isConnectFailure(e: unknown): boolean {
  const err = e as { code?: string; message?: string; errors?: unknown[] } | null;
  if (!err) return false;
  const codes = ['ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN'];
  if (err.code && codes.includes(err.code)) return true;
  if (Array.isArray(err.errors) && err.errors.length && err.errors.every((x) => isConnectFailure(x))) return true;
  // pg-pool's wording for a connection that timed out while opening is "Connection terminated due to connection timeout"
  return /timeout exceeded when trying to connect|Connection terminated (unexpectedly|due to connection timeout)/i.test(err.message ?? '') && !/statement/i.test(err.message ?? '');
}

// every query gets one more try when the connection could not be made
const rawQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
(pool as unknown as { query: unknown }).query = async (...a: unknown[]) => {
  try { return await rawQuery(...a); } catch (e) { if (!isConnectFailure(e)) throw e; return rawQuery(...a); }
};

// keep a few connections open and the database awake, so a page never pays for a new connection
if (normalizedConnectionString && process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const warm = () => { for (let i = 0; i < 2; i++) void pool.query('select 1').catch(() => undefined); };
  setTimeout(warm, 500).unref?.();
  setInterval(warm, 60_000).unref?.();
}

export const db = drizzle(pool, { schema });

export * from './schema.js';
