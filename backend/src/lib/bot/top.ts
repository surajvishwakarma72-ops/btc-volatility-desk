import type { GroupStats } from './analytics.js';

/**
 * Picks the best-performing strategy book from per-book statistics and explains why, in plain words.
 * Pure: the same function ranks live paper results and the historical replay.
 */
export interface TopPick {
  key: string;
  trades: number;
  avgPnl: number;
  netPnl: number;
  winRate: number;
  stopRate: number;
  maxDrawdown: number;
  /** Enough trades to lean on. When false the pick is only an early read. */
  confident: boolean;
  /** True when even the best book loses money on average. */
  allLosing: boolean;
  reason: string;
  runnerUp: { key: string; avgPnl: number } | null;
}

export interface TopOptions {
  /** Books with fewer trades than this are only ranked when no book has enough. */
  minTrades?: number;
  label?: (key: string) => string;
}

const money = (v: number, d = 2) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(d)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function pickTop(groups: readonly GroupStats[], opts: TopOptions = {}): TopPick | null {
  const minTrades = opts.minTrades ?? 20;
  const label = opts.label ?? ((k: string) => k);
  const pool = groups.filter((g) => g.trades > 0);
  if (!pool.length) return null;
  const enough = pool.filter((g) => g.trades >= minTrades);
  const ranked = [...(enough.length ? enough : pool)].sort((a, b) => b.avgPnl - a.avgPnl || b.netPnl - a.netPnl);
  const best = ranked[0]!;
  const next = ranked[1] ?? null;
  const confident = best.trades >= minTrades;
  const allLosing = best.avgPnl <= 0;

  const parts: string[] = [];
  parts.push(
    allLosing
      ? `${label(best.key)} is the least bad so far: it averages ${money(best.avgPnl)} per trade over ${best.trades} trades, and no strategy is profitable yet`
      : `${label(best.key)} leads: it averages ${money(best.avgPnl)} per trade (${money(best.netPnl, 0)} in total) over ${best.trades} trades`,
  );
  parts.push(`it wins ${pct(best.winRate)} of the time, hits its stop on ${pct(best.stopRate)} of trades, and its worst stretch lost $${best.maxDrawdown.toFixed(0)}`);
  if (next) parts.push(`the next best, ${label(next.key)}, averages ${money(next.avgPnl)}`);
  if (!confident) parts.push(`only ${best.trades} trades so far (fewer than ${minTrades}), so treat this as an early read, not a result`);
  else if (enough.length < pool.length) parts.push(`books with fewer than ${minTrades} trades were left out of the ranking`);

  return {
    key: best.key,
    trades: best.trades,
    avgPnl: best.avgPnl,
    netPnl: best.netPnl,
    winRate: best.winRate,
    stopRate: best.stopRate,
    maxDrawdown: best.maxDrawdown,
    confident,
    allLosing,
    reason: parts.join('; ') + '.',
    runnerUp: next ? { key: next.key, avgPnl: next.avgPnl } : null,
  };
}
