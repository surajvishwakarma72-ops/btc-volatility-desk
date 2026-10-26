import { pool } from '../../db/index.js';
import { ensureAuthSchema } from '../auth-store.js';
import { clockIv, istMinuteOfDay, latest, valueAgo, type ClockIv, type Sample } from '../../lib/algo/series-math.js';

/**
 * The server's own memory of ATM IV and DVOL, so a condition can ask "is it falling?" or "is IV above its usual level for this clock time?".
 *  - One sample a minute is written from the live option chain (ATM IV) and the DVOL poller.
 *  - DVOL is also backfilled from Deribit (5 minute points for the last day, hourly for two weeks), so DVOL conditions work straight away.
 *  - ATM IV has no public history, so it builds up from the first day this runs: until it has some days, the clock comparison says which
 *    series it used and how many days it saw.
 * Nothing here trades or changes anything.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS algo_series (
  t timestamptz PRIMARY KEY,
  atm_iv numeric,
  dvol numeric,
  spot numeric
);
`;

let ready: Promise<void> | null = null;
export function ensureSeriesSchema(): Promise<void> {
  if (!ready) {
    ready = ensureAuthSchema().then(() => pool.query(DDL)).then(() => undefined);
    ready.catch(() => { ready = null; });
  }
  return ready;
}

export type { Sample };

const minuteOf = (ms: number) => Math.floor(ms / 60_000) * 60_000;
const nz = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : null);

/** Write one sample; a column that is null never overwrites a value another writer already stored for that minute. */
export async function recordSample(s: Sample): Promise<void> {
  await ensureSeriesSchema();
  await pool.query(
    `INSERT INTO algo_series (t, atm_iv, dvol, spot) VALUES (to_timestamp($1::double precision / 1000.0), $2, $3, $4)
     ON CONFLICT (t) DO UPDATE SET atm_iv = COALESCE($2, algo_series.atm_iv), dvol = COALESCE($3, algo_series.dvol), spot = COALESCE($4, algo_series.spot)`,
    [minuteOf(s.t), nz(s.atmIv), nz(s.dvol), nz(s.spot)],
  );
}

export async function recordMany(input: readonly Sample[]): Promise<void> {
  // one statement cannot touch the same minute twice: keep the last value given for each minute
  const byMinute = new Map<number, Sample>();
  for (const r of input) byMinute.set(minuteOf(r.t), r);
  const rows = [...byMinute.values()];
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    const vals: unknown[] = [];
    const tuples = part.map((r, k) => { vals.push(minuteOf(r.t), nz(r.atmIv), nz(r.dvol), nz(r.spot)); return `(to_timestamp($${k * 4 + 1}::double precision / 1000.0), $${k * 4 + 2}::numeric, $${k * 4 + 3}::numeric, $${k * 4 + 4}::numeric)`; });
    await ensureSeriesSchema();
    await pool.query(
      `INSERT INTO algo_series (t, atm_iv, dvol, spot) VALUES ${tuples.join(',')}
       ON CONFLICT (t) DO UPDATE SET atm_iv = COALESCE(EXCLUDED.atm_iv, algo_series.atm_iv), dvol = COALESCE(EXCLUDED.dvol, algo_series.dvol), spot = COALESCE(EXCLUDED.spot, algo_series.spot)`,
      vals,
    );
  }
}

/** Samples from `sinceMs` to now, oldest first */
export async function loadSeries(sinceMs: number): Promise<Sample[]> {
  await ensureSeriesSchema();
  const r = await pool.query('SELECT t, atm_iv, dvol, spot FROM algo_series WHERE t >= to_timestamp($1::double precision / 1000.0) ORDER BY t', [sinceMs]);
  return (r.rows as any[]).map((x) => ({ t: new Date(x.t).getTime(), atmIv: x.atm_iv == null ? null : Number(x.atm_iv), dvol: x.dvol == null ? null : Number(x.dvol), spot: x.spot == null ? null : Number(x.spot) }));
}

export { valueAgo, latest, istMinuteOfDay, clockIv };
export type { ClockIv };

// ---------- Deribit DVOL backfill ----------

type Fetcher = (startMs: number, endMs: number, resolutionSec: number) => Promise<Array<[number, number]>>;

const realDvolFetch: Fetcher = async (start, end, res) => {
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=${res}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'BTC-Volatility-Desk' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error('Deribit HTTP ' + r.status);
  const j = (await r.json()) as { result?: { data?: Array<[number, number, number, number, number]> } };
  return (j.result?.data ?? []).map((p) => [Number(p[0]), Number(p[4])] as [number, number]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
};

/** Fill DVOL history if the table is thin: hourly for two weeks, 5 minute for the last day. Safe to run on every start. */
export async function backfillDvol(nowMs = Date.now(), fetcher: Fetcher = realDvolFetch): Promise<number> {
  await ensureSeriesSchema();
  const have = await pool.query('SELECT COUNT(*)::int AS n FROM algo_series WHERE dvol IS NOT NULL AND t >= to_timestamp($1::double precision / 1000.0)', [nowMs - 14 * 86_400_000]);
  if (Number((have.rows[0] as { n: number }).n) > 400) return 0;
  const [hourly, fine] = await Promise.all([fetcher(nowMs - 14 * 86_400_000, nowMs, 3600), fetcher(nowMs - 86_400_000, nowMs, 300)]);
  const rows = [...hourly, ...fine].map(([t, v]) => ({ t, atmIv: null, dvol: v, spot: null }));
  await recordMany(rows);
  return rows.length;
}
