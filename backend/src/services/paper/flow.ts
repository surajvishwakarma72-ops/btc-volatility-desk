import { pool } from '../../db/index.js';
import { describeFlow, summariseTrades, type BucketSums, type DeribitTrade } from '../../lib/option-flow.js';

/**
 * Option flow for the Strategy builder: the desk's own 15-minute flow buckets (call and put buying and selling,
 * block trades) for the last 1, 4 and 24 hours, plus a live per-strike read from Deribit's most recent option prints.
 * Cached for 30 seconds. Read-only; flow is a record of what was traded, not a forecast.
 */
export interface FlowWindow extends BucketSums {
  hours: number;
  read: string;
}

export interface FlowSnapshot {
  asOf: number;
  windows: FlowWindow[] | null;
  strikes: ReturnType<typeof summariseTrades>['strikes'];
  big: ReturnType<typeof summariseTrades>['big'];
  /** Hours of the live per-strike read (the recent-trades feed holds only so many prints). */
  strikeHours: number;
  note: string | null;
}

let cache: { at: number; v: FlowSnapshot } | null = null;
let pending: Promise<FlowSnapshot> | null = null;

async function bucketWindows(): Promise<FlowWindow[] | null> {
  try {
    const out: FlowWindow[] = [];
    for (const hours of [1, 4, 24]) {
      const r = await pool.query(
        `SELECT COALESCE(SUM(call_buy_vol),0)::float AS cb, COALESCE(SUM(call_sell_vol),0)::float AS cs,
                COALESCE(SUM(put_buy_vol),0)::float AS pb, COALESCE(SUM(put_sell_vol),0)::float AS ps,
                COALESCE(SUM(COALESCE(block_call_buy_vol,0)+COALESCE(block_call_sell_vol,0)+COALESCE(block_put_buy_vol,0)+COALESCE(block_put_sell_vol,0)),0)::float AS blk,
                COALESCE(SUM(trade_count),0)::int AS n
           FROM option_flow_buckets WHERE symbol = 'BTC' AND time >= now() - ($1 || ' hours')::interval`,
        [String(hours)],
      );
      const x = r.rows[0] as any;
      const sums: BucketSums = { callBuy: Number(x.cb), callSell: Number(x.cs), putBuy: Number(x.pb), putSell: Number(x.ps), blockVol: Number(x.blk), trades: Number(x.n) };
      out.push({ hours, ...sums, read: describeFlow(sums) });
    }
    return out;
  } catch {
    return null;
  }
}

async function load(): Promise<FlowSnapshot> {
  const now = Date.now();
  const windows = await bucketWindows();
  let strikes: FlowSnapshot['strikes'] = [];
  let big: FlowSnapshot['big'] = [];
  let note: string | null = null;
  try {
    const res = await fetch('https://www.deribit.com/api/v2/public/get_last_trades_by_currency?currency=BTC&kind=option&count=1000&include_old=true', {
      headers: { 'User-Agent': 'BTC-Volatility-Desk' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { result?: { trades?: DeribitTrade[] } };
    const trades = json.result?.trades ?? [];
    const s = summariseTrades(trades, now, 4);
    strikes = s.strikes;
    big = summariseTrades(trades, now, 24).big;
    if (!trades.length) note = 'Deribit returned no recent option trades.';
  } catch (e) {
    note = `Live strike flow is unavailable right now (${(e as Error).message}).`;
  }
  return { asOf: now, windows, strikes, big, strikeHours: 4, note };
}

export function getOptionFlow(): Promise<FlowSnapshot> {
  if (cache && Date.now() - cache.at < 30_000) return Promise.resolve(cache.v);
  if (!pending) {
    pending = load().then((v) => { cache = { at: Date.now(), v }; return v; }).finally(() => { pending = null; });
  }
  return pending;
}
