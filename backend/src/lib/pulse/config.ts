/** Strangle Pulse collector constants. Read-only paper cohorts; nothing here places orders. */
export const PULSE_CONFIG = {
  /** Snapshot cadence in minutes. */
  snapshotMinutes: 15,
  /** How late (ms) a cohort may still be opened after its slot start. */
  lateOpenGraceMs: 300_000,
  /** API responses older than this (ms) are treated as stale. This shows the API is alive, not that the book moved. */
  staleQuoteMs: 120_000,
  /** Per-leg stop as a multiple of entry premium. */
  stopMultiple: 2,
  /** A stop needs ask <= this multiple of mark, so a spiked ask on a thin book does not latch. */
  maxAskToMark: 1.5,
  /** Consecutive ticks with an unchanged book before the feed counts as frozen. */
  frozenTicks: 5,
  /** Assumed slippage as a fraction of premium (estimate, not measured). */
  slippagePct: 0.01,
  lots: 1,
  /** Strikes either side of ATM kept in the OI band. */
  oiBandStrikes: 2,
  futuresSymbol: 'BTCUSD',
  /** Taker fee rate for the futures hedge leg. */
  futuresTakerRate: 0.0005,
  /** BTC per futures contract. */
  futuresContractValue: 0.001,
} as const;

/** Strangle Pulse metric thresholds. Every cut-off used by the pure metric functions lives here. */
export const METRIC_CONFIG = {
  /** Minimum gap between call and put now/entry ratios before one leg counts as heavy. */
  heavyLegGap: 0.1,
  /** Minimum absolute spot move (percent) for the delta shift index to be meaningful. */
  minMovePct: 0.02,
  /** Snapshot steps that make up the last hour. */
  lastHourSteps: 4,
  /** Delta band around the short strikes treated as near. */
  nearDeltaBand: 0.05,
  /** Fewest same-session samples before a baseline is trusted. */
  sessionMinSamples: 10,
  /** Whether an OI signal needs rising volume to be confirmed. */
  volumeConfirmsOi: true,
  /** Exit cost (fraction of premium) from which the liquidity score is penalised. */
  exitCostPenalty: 0.05,
  /** Exit cost above which liquidity vetoes the entry. */
  exitCostVeto: 0.1,
  /** Leg spread (fraction of mid) above which the spread vetoes the entry. */
  spreadVetoPct: 0.1,
  /** Spread veto when the spread exceeds this multiple of its 24h median. */
  spreadVetoMedianMultiple: 2,
  /** Newest samples counted for hedge-winner persistence. */
  persistenceWindow: 6,
} as const;
