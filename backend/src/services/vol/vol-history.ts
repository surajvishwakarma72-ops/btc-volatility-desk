/**
 * History for the compression / IV-regime read: ~90 days of hourly BTC bars and a year of daily bars (Binance public
 * data), a year of daily DVOL and 4 days of hourly DVOL (Deribit public). Cached for 10 minutes; a failed refresh keeps
 * the last good copy for up to 6 hours, after that the read is "unavailable" rather than stale.
 */
import { readVol, type Bar, type IvPoint, type VolRead } from '../../lib/vol/regime.js';
import { deribitWorker } from '../deribit-flow-worker.js';

const FRESH_MS = 10 * 60_000, STALE_MS = 6 * 3_600_000;
const BIN = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT';
const DRB = 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC';

async function json(url: string): Promise<any> {
  const r = await fetch(url, { headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

async function klines(interval: '1h' | '1d', pages: number): Promise<Bar[]> {
  const out: Bar[] = [];
  let end = Date.now();
  for (let i = 0; i < pages; i++) {
    const rows = (await json(`${BIN}&interval=${interval}&limit=1000&endTime=${end}`)) as unknown[][];
    if (!rows.length) break;
    out.push(...rows.map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]) })));
    end = Number(rows[0]![0]) - 1;
  }
  return [...new Map(out.map((b) => [b.t, b])).values()].sort((a, b) => a.t - b.t);
}

async function dvol(resolution: string, days: number): Promise<IvPoint[]> {
  const now = Date.now();
  const j = await json(`${DRB}&start_timestamp=${now - days * 86_400_000}&end_timestamp=${now}&resolution=${resolution}`);
  const rows = (j?.result?.data ?? []) as number[][];
  return rows.map((r) => ({ t: Number(r[0]), v: Number(r[4]) })).filter((p) => Number.isFinite(p.v));
}

let cache: { at: number; data: { bars1h: Bar[]; closes1d: Bar[]; dvolDaily: IvPoint[]; dvolHourly: IvPoint[] } } | null = null;
let loading: Promise<void> | null = null;

async function refresh(): Promise<void> {
  const [bars1h, closes1d, dvolDaily, dvolHourly] = await Promise.all([klines('1h', 3), klines('1d', 1), dvol('1D', 370), dvol('3600', 4)]);
  if (bars1h.length < 24 * 30 || dvolDaily.length < 200) throw new Error('history too short');
  cache = { at: Date.now(), data: { bars1h, closes1d, dvolDaily, dvolHourly } };
}

/** The hourly bars behind the last read (for the tripwire); empty before the first load. */
export function cachedBars1h(): Bar[] { return cache?.data.bars1h ?? []; }

/** The current read, or null when no history could be loaded (the checklist then shows a red "no data" tick). */
export async function volRead(now = Date.now()): Promise<VolRead | null> {
  if (!cache || now - cache.at > FRESH_MS) {
    loading = loading ?? refresh().catch((e) => { console.warn('[vol] history refresh failed:', e instanceof Error ? e.message : e); }).finally(() => { loading = null; });
    if (!cache) await loading; else void loading;
  }
  if (!cache || now - cache.at > STALE_MS) return null;
  const live = deribitWorker.currentDvol;
  return readVol({ nowMs: now, ...cache.data, ivNow: typeof live === 'number' && Number.isFinite(live) ? live : null });
}
