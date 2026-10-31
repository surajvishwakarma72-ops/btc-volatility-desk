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
  /** Minimum absolute spot move (percent) for the Delta Stability Index to be meaningful. */
  minMovePct: 0.02,
  /** Band around 25 delta within which the nearest option counts as the 25-delta quote for the risk reversal. */
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
  /** Age (minutes after opened_at) at which each cohort's hedge winner is judged, so cohorts are compared like for like. */
  persistenceAgeMinutes: 60,
  /** Fewest judged cohorts before winner persistence gives a reading. */
  persistenceMinCohorts: 4,
  /** Fewest good steps before the efficiency ratio is reported; a short path reads as a straight line. */
  minPathSteps: 4,
  /** Fewest prior rows in the last 24h before a spread median exists, so the median-multiple veto cannot fire on thin history. */
  spreadMedianMinSamples: 6,
  /** A newest market grid older than this (ms) is stale: skew and term structure are not reported. */
  marketStaleMs: 1_200_000,
  /** Current ATM IV must exceed next by more than this (vol points) for the term structure to count as inverted. */
  termInversionMinPts: 0.5,
} as const;

/** Regime indicator thresholds, ported from the desk's browser regime code (frontend/index.html `regimeCompute`, `dailyRv`, `adxSeries`). */
export const REGIME_CONFIG = {
  /** Wilder ADX period (bars). */
  adxPeriod: 14,
  /** Newest 1h bars fed to ADX. */
  adxBars: 720,
  /** ADX is compared with the value this many bars before the last one (the 7th from the end). */
  adxLookbackBars: 6,
  /** ADX counts as rising when it gained at least this many points over the lookback. */
  adxRiseMin: 0.5,
  /** Fewest real hours a UTC day needs for its realised vol to count. */
  minDaysHours: 20,
  /** Fewest daily RV points before the volatility percentile is trusted. */
  rvpMinDays: 60,
  /** Newest daily RV points kept as the one-year percentile reference. */
  rvpDays: 372,
  /** Rolling realised-vol window in days for the percentile reference. */
  rvpWindowDays: 7,
  /** RVP counts as rising when it gained at least this much (fraction of the distribution) over the previous day. */
  rvpRiseMin: 0.02,
  /** Hours in the rolling realised-vol window that sets the live RV (7 days). */
  rvWindowHours: 168,
  /** A realised-vol window needs this fraction of its hours covered. */
  rvCoverageMin: 0.6,
  /** Hours per year used to annualise realised vol. */
  hoursPerYear: 8760,
} as const;

/** Live regime gate (spec-adx25): IV/RV24 above, ADX below, not killer, DVOL below. Thresholds are strict, as backtested. */
export const REGIME_GATE_CONFIG = {
  gateId: 'spec-adx25',
  /** IV/RV24 must be strictly above this. */
  ivRvMin: 1.3,
  /** ADX must be strictly below this. */
  adxMax: 25,
  /** DVOL must be strictly below this. */
  dvolMax: 65,
  /** DVOL to ATM-IV scale used by the backtest. */
  ivScaleK: 0.8811,
  /** Hours in the realised-vol window. */
  rvHours: 24,
  /** A DVOL reading older than this (ms) is unavailable (10 minutes). */
  dvolMaxAgeMs: 600_000,
  /** Newest hourly bar open older than this (ms) makes bar inputs unavailable (2.5 hours). */
  barsMaxAgeMs: 9_000_000,
  backfillBars: 9500,
  barsKept: 9300,
} as const;
