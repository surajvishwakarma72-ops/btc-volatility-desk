import { pool } from '../../db/index.js';
import { rankIndicators, type Insights } from '../../lib/algo/insights.js';
import type { Bar } from '../../lib/bot/futures.js';
import { fetchCandles } from '../bot/delta-public.js';
import { ensureAlgoSchema } from './algo-store.js';

/**
 * The learning side of the Algo panel.
 *  1. Market insights: which indicators worked on the last four weeks of 15 minute BTC candles (recomputed every few hours).
 *  2. Your own record: for every condition you used, how your own finished runs did when it was true at entry.
 * Both only report what was recorded. Neither changes a rule on its own: you decide what to add.
 */
const DAYS = 28;
const TTL = 3 * 3_600_000;
let cache: { at: number; v: Insights } | null = null;

export interface Fetcher { (startSec: number, endSec: number): Promise<Bar[]> }
const realFetch: Fetcher = (a, b) => fetchCandles('BTCUSD', '15m', a, b);

export async function loadInsights(fetcher: Fetcher = realFetch, nowMs = Date.now(), force = false): Promise<Insights> {
  if (!force && cache && nowMs - cache.at < TTL) return cache.v;
  const end = Math.floor(nowMs / 1000), mid = end - (DAYS / 2) * 86_400, start = end - DAYS * 86_400;
  const [a, b] = await Promise.all([fetcher(start, mid), fetcher(mid, end)]);
  const seen = new Set<number>();
  const bars = [...a, ...b].filter((x) => (seen.has(x.t) ? false : (seen.add(x.t), true))).sort((x, y) => x.t - y.t);
  // the last bar is still forming
  const v = rankIndicators(bars.slice(0, -1));
  cache = { at: nowMs, v };
  return v;
}
export const clearInsightsCache = () => { cache = null; };

export interface OwnStat { label: string; runs: number; wins: number; avgPnl: number; totalPnl: number }

/** Per condition: how this user's finished runs did when that condition was true at entry. Needs finished runs to say anything. */
export async function ownRunStats(userId: string): Promise<{ finished: number; wins: number; totalPnl: number; byCondition: OwnStat[] }> {
  await ensureAlgoSchema();
  const r = await pool.query(`SELECT net_pnl, plan FROM algo_runs WHERE user_id = $1 AND status = 'exited' AND net_pnl IS NOT NULL ORDER BY created_at DESC LIMIT 500`, [userId]);
  const rows = r.rows as Array<{ net_pnl: string; plan: any }>;
  const by = new Map<string, OwnStat>();
  let wins = 0, total = 0;
  for (const x of rows) {
    const pnl = Number(x.net_pnl);
    total += pnl; if (pnl > 0) wins++;
    const conds = (x.plan?.conds ?? []) as Array<{ label: string; ok: boolean }>;
    for (const c of conds) {
      if (!c.ok) continue;
      const s = by.get(c.label) ?? { label: c.label, runs: 0, wins: 0, avgPnl: 0, totalPnl: 0 };
      s.runs++; s.totalPnl += pnl; if (pnl > 0) s.wins++;
      by.set(c.label, s);
    }
  }
  const byCondition = [...by.values()].map((s) => ({ ...s, avgPnl: s.totalPnl / s.runs })).sort((a, b) => b.avgPnl - a.avgPnl);
  return { finished: rows.length, wins, totalPnl: total, byCondition };
}
