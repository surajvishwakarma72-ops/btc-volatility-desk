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
  /** Fewest completed bars before bar inputs are trusted: 372 days, as the browser's RVP window needs 366 rolling 7-day values. */
  minBars: 8928,
} as const;

/** Strangle Pulse confidence score: every weight and cut-off. Initial weights are untested judgement until calibration (Phase 7). */
export const SCORE_CONFIG = {
  weights: { decay: 20, realized: 15, delta: 15, balance: 15, iv: 10, oi: 10, futures: 10, liquidity: 5 },
  /** Cohort groups by recency: newest 3 count 60%, next 3 count 30%, the rest 10%. */
  recency: [{ upTo: 3, weight: 0.6 }, { upTo: 6, weight: 0.3 }, { upTo: 99, weight: 0.1 }],
  /** Linear 0-100 maps: [value that scores 0, value that scores 100]. */
  map: {
    de: [0.3, 1.0], rangeRatio: [1.0, 0.7], dsi: [3, 1], netDeltaAbs: [0.3, 0.05], balanceDrift: [0.5, 0.1],
    ivChange1h: [2, -2], efficiency: [0.6, 0.2], moveVsBreakeven: [0.6, 0.3],
  },
  oiScore: { short_buildup: 100, long_unwinding: 65, long_buildup: 0, short_covering: 0 },
  liquidityScore: { normal: 100, penalty: 50, veto: 0 },
  zones: { sellMin: 70, cautionMin: 45 },
  vetoCap: 40,
  /** Fewest weight points present before a cohort gets a score. */
  minWeightPresent: 40,
  /** A cohort whose newest step is older than this (ms) before the reading is stale. */
  staleStepMs: 1_800_000,
  /** Consecutive readings on the new side before the zone changes. */
  hysteresisReadings: 2,
  /** Hours of readings returned. */
  historyHours: 48,
} as const;

/** Strangle Pulse risk lines (0 = calm, in the green sell zone; 100 = unfavourable, in the no-sell zone). [calm value, bad value] maps. */
export const LINE_CONFIG = {
  map: {
    ivChange1h: [-2, 2], decay: [1.0, 0.3], deltaSpeed: [0, 0.04], gammaSpeed: [0, 0.3], moveNorm: [0, 1.0], efficiency: [0.2, 0.6],
  },
  /** Threat score of an OI read on a sold leg: writers adding is calm, fresh buyers or covering is not. */
  oiRisk: { short_buildup: 0, long_unwinding: 35, long_buildup: 100, short_covering: 100 },
} as const;

/** Strangle Pulse minute damage: how fast a sold leg's premium rises against the BTC move, and when that trips the trigger. */
export const DAMAGE_CONFIG = {
  /** Minutes back the change is measured over. */
  windowMin: 5,
  /** Smallest BTC move (percent) used as the divisor, so a flat market does not divide by zero. */
  moveFloorPct: 0.02,
  /** Linear 0-100 map on the premium-up to BTC-move ratio: [ratio that scores 0, ratio that scores 100]. */
  map: [5, 30],
  weight: 30,
  /** A side only trips the trigger when its premium is up at least this percent of entry. */
  triggerPremiumPct: 10,
  /** Consecutive steps at score 100 before the trigger turns on. */
  triggerMinutes: 2,
  /** Consecutive steps below the levels before the trigger clears. */
  clearMinutes: 10,
  zoneReadings: 5,
  futuresWindowMin: 60,
  futuresMap: [0, 1],
  lineDamageShare: 0.6,
  retentionDays: 45,
} as const;
