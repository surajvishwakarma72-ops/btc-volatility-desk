import { pool } from '../../db/index.js';
import { DEFAULT_WATCH, normaliseSettings, type WatchSettings } from '../../lib/watch/classify.js';
import { ensureAuthSchema } from '../auth-store.js';

/**
 * Per-user alarm settings and the live-exit switches. Everything about trading is OFF by default: the user has to save a trading key,
 * arm it, and turn off dry-run themselves, and the server owner has to set LIVE_TRADING_ENABLED. See services/watch/live-exit.ts.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS desk_watch_settings (
  user_id uuid PRIMARY KEY,
  warn_points numeric NOT NULL DEFAULT 20,
  hard_points numeric NOT NULL DEFAULT 5,
  stop_multiple numeric NOT NULL DEFAULT 2,
  watch_real boolean NOT NULL DEFAULT true,
  live_armed boolean NOT NULL DEFAULT false,
  dry_run boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS desk_watch_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  symbol text,
  detail text NOT NULL,
  dry_run boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS desk_watch_events_user_idx ON desk_watch_events (user_id, at DESC);
CREATE TABLE IF NOT EXISTS desk_delta_trade_keys (
  user_id uuid PRIMARY KEY,
  key_enc text NOT NULL, key_salt text NOT NULL, key_iv text NOT NULL, key_tag text NOT NULL,
  secret_enc text NOT NULL, secret_salt text NOT NULL, secret_iv text NOT NULL, secret_tag text NOT NULL,
  key_last4 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  last_error text
);
`;

let ready: Promise<void> | null = null;
export function ensureWatchSchema(): Promise<void> {
  if (!ready) {
    ready = ensureAuthSchema().then(() => pool.query(DDL)).then(() => undefined);
    ready.catch(() => { ready = null; });
  }
  return ready;
}

export interface UserWatchConfig extends WatchSettings {
  watchReal: boolean;
  liveArmed: boolean;
  dryRun: boolean;
}

const cache = new Map<string, { at: number; v: UserWatchConfig }>();

const map = (r: any | undefined): UserWatchConfig => ({
  ...normaliseSettings(r ? { warnPoints: Number(r.warn_points), hardPoints: Number(r.hard_points), stopMultiple: Number(r.stop_multiple) } : null),
  watchReal: r ? !!r.watch_real : true,
  liveArmed: r ? !!r.live_armed : false,
  dryRun: r ? !!r.dry_run : true,
});

export async function getWatchConfig(userId: string, maxAgeMs = 20_000): Promise<UserWatchConfig> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.v;
  await ensureWatchSchema();
  const r = await pool.query('SELECT * FROM desk_watch_settings WHERE user_id = $1', [userId]);
  const v = map(r.rows[0]);
  cache.set(userId, { at: Date.now(), v });
  return v;
}

export async function saveWatchConfig(userId: string, patch: Partial<UserWatchConfig>): Promise<UserWatchConfig> {
  const cur = await getWatchConfig(userId, 0);
  const s = normaliseSettings({ ...cur, ...patch });
  const next: UserWatchConfig = {
    ...s,
    watchReal: patch.watchReal ?? cur.watchReal,
    liveArmed: patch.liveArmed ?? cur.liveArmed,
    dryRun: patch.dryRun ?? cur.dryRun,
  };
  await pool.query(
    `INSERT INTO desk_watch_settings (user_id, warn_points, hard_points, stop_multiple, watch_real, live_armed, dry_run, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (user_id) DO UPDATE SET warn_points=$2, hard_points=$3, stop_multiple=$4, watch_real=$5, live_armed=$6, dry_run=$7, updated_at=now()`,
    [userId, next.warnPoints, next.hardPoints, next.stopMultiple, next.watchReal, next.liveArmed, next.dryRun],
  );
  cache.set(userId, { at: Date.now(), v: next });
  return next;
}

export const defaultConfig = (): UserWatchConfig => ({ ...DEFAULT_WATCH, watchReal: true, liveArmed: false, dryRun: true });

export async function logWatchEvent(userId: string, kind: string, detail: string, opts: { symbol?: string; dryRun?: boolean } = {}): Promise<void> {
  await ensureWatchSchema();
  await pool.query('INSERT INTO desk_watch_events (user_id, kind, symbol, detail, dry_run) VALUES ($1,$2,$3,$4,$5)', [userId, kind, opts.symbol ?? null, detail.slice(0, 600), opts.dryRun ?? true]);
}

export async function recentWatchEvents(userId: string, limit = 30) {
  await ensureWatchSchema();
  const r = await pool.query('SELECT at, kind, symbol, detail, dry_run FROM desk_watch_events WHERE user_id = $1 ORDER BY at DESC, id DESC LIMIT $2', [userId, limit]);
  return (r.rows as any[]).map((x) => ({ at: new Date(x.at).getTime(), kind: x.kind as string, symbol: (x.symbol ?? null) as string | null, detail: x.detail as string, dryRun: !!x.dry_run }));
}
