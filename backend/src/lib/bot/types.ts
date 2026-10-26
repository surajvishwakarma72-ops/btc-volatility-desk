/**
 * Shared types for the trading bot (paper first, live later).
 * Everything under lib/bot is pure: no I/O, no clocks, so the same code runs in live,
 * paper, testnet and historical replay.
 */

export type StrategyId =
  | 'ASIA_SHORT'
  | 'NY_SHORT'
  | 'EVE_LONG'
  | 'PRE_LONG'
  | 'CAL_BACK';

/** `always` trades daily; `gated` trades only when the GO/WAIT gate says GO. */
export type Book = 'always' | 'gated';
export type BotMode = 'paper' | 'testnet' | 'live';

export type Side = 'long' | 'short';
export type OptionType = 'call' | 'put';

export interface Leg {
  symbol: string;
  type: OptionType;
  side: Side;
  strike: number;
  /** Expiry as epoch ms (settlement time). */
  expiryMs: number;
  /** Lots (Delta contract_value, 0.001 BTC per lot, converts to underlying size). */
  lots: number;
  /** Average fill price (USD premium per 1 BTC underlying). */
  entryPrice: number;
  /** Role inside multi-leg structures: bodies are the straddle/strangle legs, front/back the calendar's. */
  role: 'body' | 'front' | 'back';
}

export interface LegMark {
  symbol: string;
  mark: number;
}

export interface ExitConfig {
  /** Short-leg stop: exit everything when any short body leg mark reaches this multiple of its entry price. */
  stopMultiple?: number;
  /** Hard exit: close everything when a short body leg is within this many option points of its stop (default 0 = only at the stop). */
  hardPoints?: number;
  /** Take profit as a fraction of margin, e.g. 0.10 = 10% of margin. */
  tpPctOfMargin?: number;
  /** Stop loss as a fraction of margin (long straddles): 0.10 = lose 10% of margin. */
  slPctOfMargin?: number;
  /** Absolute time exit (epoch ms). */
  exitAtMs?: number;
  /** Hard safety close for structures that contain a short leg that can expire (calendar). */
  hardCloseAtMs?: number;
  /** Calendar breakeven band: exit when spot leaves [low, high]. */
  breakeven?: { low: number; high: number };
}

export interface PositionSnapshot {
  legs: Leg[];
  marks: LegMark[];
  spot: number;
  /** Margin blocked by the structure, in USD. */
  marginUsd: number;
  /** Contract value in underlying units per lot (0.001 BTC). */
  contractValue: number;
  /** Fees already paid (entry), in USD. Excluded from `grossPnl`, included in `netPnl`. */
  feesPaidUsd: number;
}

export type ExitReason = 'stop' | 'tp' | 'sl' | 'time' | 'breakeven' | 'hard_close';

export type ExitDecision =
  | { action: 'hold' }
  | { action: 'exit'; reason: ExitReason; detail: string };

export interface PnlBreakdown {
  grossPnl: number;
  netPnl: number;
  pctOfMargin: number;
  perLeg: Array<{ symbol: string; pnl: number }>;
}
