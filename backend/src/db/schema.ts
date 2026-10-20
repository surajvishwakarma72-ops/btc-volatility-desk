import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  numeric,
  timestamp,
  date,
  integer,
  jsonb,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * 1. Users Table
 * 
 * Canonical user account record supporting single-user operation today
 * and multi-user SaaS tenancy in the future without schema changes.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 100 }),
  role: varchar('role', { length: 20 }).default('trader').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 2. Encrypted Exchange & Notification API Credentials
 * 
 * Stores sensitive credentials encrypted with AES-256-GCM.
 * Client browsers never receive these secrets.
 */
export const apiCredentials = pgTable('api_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  exchange: varchar('exchange', { length: 50 }).notNull(), // 'delta_india' | 'deribit' | 'binance' | 'telegram' | 'ntfy'
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  apiSecretEncrypted: text('api_secret_encrypted'),
  salt: varchar('salt', { length: 64 }).notNull(),
  iv: varchar('iv', { length: 32 }).notNull(),
  tag: varchar('tag', { length: 32 }).notNull(),
  meta: jsonb('meta').default('{}'), // e.g. chat_id, ntfy_topic, testnet flag
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 3. Trades & Strangle Executions (Summary Header)
 * 
 * Tracks active and closed strangle positions, strike parameters,
 * execution IV, realized P&L, and Greek attribution.
 * Flattened strike/IV fields retained for fast summary queries.
 */
export const trades = pgTable('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  strategy: varchar('strategy', { length: 50 }).default('SHORT_STRANGLE').notNull(),
  status: varchar('status', { length: 20 }).default('OPEN').notNull(), // 'OPEN' | 'CLOSED' | 'CANCELLED'
  underlying: varchar('underlying', { length: 20 }).default('BTC').notNull(),
  expiryDate: timestamp('expiry_date', { withTimezone: true }).notNull(),
  callStrike: numeric('call_strike', { precision: 12, scale: 2 }).notNull(),
  putStrike: numeric('put_strike', { precision: 12, scale: 2 }).notNull(),
  entryTime: timestamp('entry_time', { withTimezone: true }).notNull(),
  exitTime: timestamp('exit_time', { withTimezone: true }),
  entrySpot: numeric('entry_spot', { precision: 12, scale: 2 }),
  exitSpot: numeric('exit_spot', { precision: 12, scale: 2 }),
  entryIv: numeric('entry_iv', { precision: 6, scale: 2 }),
  exitIv: numeric('exit_iv', { precision: 6, scale: 2 }),
  contracts: numeric('contracts', { precision: 10, scale: 4 }).notNull(),
  realizedPnl: numeric('realized_pnl', { precision: 12, scale: 2 }),
  exitReason: varchar('exit_reason', { length: 100 }), // 'TAKE_PROFIT' | 'STOP_LOSS' | 'IV_REVERT' | 'TIME_EXPIRY' | 'PANIC'
  entryGreeks: jsonb('entry_greeks').default('{}'), // { delta, gamma, theta, vega }
  pnlAttribution: jsonb('pnl_attribution').default('{}'), // { delta_pnl, gamma_pnl, theta_pnl, vega_pnl }
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 4. Trade Legs
 * 
 * Detailed breakdown per leg (Call and Put) for each strangle trade.
 * Tracks leg-specific entry/exit premiums, leg-specific IV, stop-loss levels,
 * and records which specific leg triggered an exit or stop-loss.
 */
export const tradeLegs = pgTable('trade_legs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tradeId: uuid('trade_id')
    .notNull()
    .references(() => trades.id, { onDelete: 'cascade' }),
  legType: varchar('leg_type', { length: 10 }).notNull(), // 'CALL' | 'PUT'
  strike: numeric('strike', { precision: 12, scale: 2 }).notNull(),
  entryPremium: numeric('entry_premium', { precision: 12, scale: 2 }),
  exitPremium: numeric('exit_premium', { precision: 12, scale: 2 }),
  entryIv: numeric('entry_iv', { precision: 6, scale: 2 }),
  exitIv: numeric('exit_iv', { precision: 6, scale: 2 }),
  status: varchar('status', { length: 20 }).default('OPEN').notNull(), // 'OPEN' | 'CLOSED' | 'STOPPED'
  stopLossLevel: numeric('stop_loss_level', { precision: 12, scale: 2 }),
  triggeredExit: boolean('triggered_exit').default(false).notNull(), // true if this leg caused exit/stop
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 5. Nightly Session Reviews
 * 
 * Replaces `localStorage['v147_nights']` and `localStorage['ivcool:nights']`.
 * Records session parameters, playbook verdict, and historical outcomes.
 */
export const nightlyReviews = pgTable(
  'nightly_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionDate: date('session_date').notNull(),
    verdict: varchar('verdict', { length: 20 }).notNull(), // 'SELL_FULL' | 'SELL_HALF' | 'NO_TRADE'
    outcome: varchar('outcome', { length: 20 }), // 'PROFIT' | 'LOSS' | 'SCRATCH' | 'NO_ENTRY'
    iv1730: numeric('iv_1730', { precision: 6, scale: 2 }),
    ivNyOpen: numeric('iv_ny_open', { precision: 6, scale: 2 }),
    ivExit: numeric('iv_exit', { precision: 6, scale: 2 }),
    speedVsIv: numeric('speed_vs_iv', { precision: 6, scale: 3 }),
    adxTrend: varchar('adx_trend', { length: 20 }), // 'FALLING' | 'FLAT' | 'RISING'
    exitHour: integer('exit_hour'),
    eventTags: text('event_tags').array(), // ['NFP', 'FED', 'EXP', 'VOTE', 'HOL']
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('user_session_date_idx').on(table.userId, table.sessionDate),
  ]
);

/**
 * 6. Chart Drawings & Annotations
 * 
 * Replaces `localStorage['btc_drawings_v1']`.
 * Canonical storage for user-drawn rays, trendlines, and levels.
 */
export const chartDrawings = pgTable('chart_drawings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  symbol: varchar('symbol', { length: 20 }).default('BTCUSDT').notNull(),
  drawingType: varchar('drawing_type', { length: 50 }).notNull(), // 'HORIZONTAL_RAY' | 'TRENDLINE' | 'BOX' | 'TEXT'
  points: jsonb('points').notNull(), // [{ time, price }]
  style: jsonb('style').notNull(), // { color, lineWidth, lineStyle }
  label: varchar('label', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 7. User Workspace Preferences
 * 
 * Replaces `v132_ind`, `v143_skin`, `pa_layer_prefs_v3`, and `btc_vol_desk_prefs_v1`.
 * Stores theme, active indicator set for fx menu, and UI geometry.
 */
export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .unique()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: varchar('theme', { length: 20 }).default('coinglass_dark').notNull(),
  activeIndicators: jsonb('active_indicators').default('[]'), // array of enabled fx indicator IDs
  chartLayout: jsonb('chart_layout').default('{}'), // multi-pane heights, collapsed sections
  riskLimits: jsonb('risk_limits').default('{}'), // max contracts, stop-loss thresholds
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 8. Alert Rules Configuration
 * 
 * Replaces `localStorage['vt_alert_prefs_v1']`.
 * Rules evaluated 24x7 by backend workers.
 */
export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ruleName: varchar('rule_name', { length: 100 }).notNull(),
  ruleType: varchar('rule_type', { length: 50 }).notNull(), // 'IV_SPIKE' | 'SPEED_BREAK' | 'PANIC_EXPANSION' | 'STOP_LOSS'
  thresholdValue: numeric('threshold_value', { precision: 10, scale: 4 }).notNull(),
  channels: text('channels').array().default(['telegram', 'ntfy', 'in_app']),
  cooldownSeconds: integer('cooldown_seconds').default(300).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 9. Alert Delivery Audit Logs
 * 
 * Replaces `localStorage['btc_alerts_v1']`.
 * Keeps audit trail of dispatched push and in-app alerts.
 */
export const alertLogs = pgTable('alert_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  alertRuleId: uuid('alert_rule_id').references(() => alertRules.id, { onDelete: 'set null' }),
  title: varchar('title', { length: 200 }).notNull(),
  message: text('message').notNull(),
  channel: varchar('channel', { length: 50 }).notNull(), // 'telegram' | 'ntfy' | 'in_app'
  status: varchar('status', { length: 20 }).default('SENT').notNull(), // 'SENT' | 'FAILED' | 'SNOOZED'
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 9b. Registered Push Notification Devices
 * 
 * Stores registered push notification device tokens (FCM/WebPush) and user-selected notification sounds.
 */
export const pushDevices = pgTable('push_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  platform: varchar('platform', { length: 20 }).default('android').notNull(),
  soundChoice: varchar('sound_choice', { length: 50 }).default('chime').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 10. Historical Market Timeseries
 * 
 * Canonical time-series storage for normalized OHLCV candles,
 * ATM IV, Realized Volatility, DVOL, and Open Interest.
 */
export const marketTimeseries = pgTable(
  'market_timeseries',
  {
    time: timestamp('time', { withTimezone: true }).notNull(),
    symbol: varchar('symbol', { length: 20 }).notNull(),
    interval: varchar('interval', { length: 10 }).notNull(), // '1m' | '5m' | '15m' | '1h' | '1d'
    open: numeric('open', { precision: 12, scale: 2 }).notNull(),
    high: numeric('high', { precision: 12, scale: 2 }).notNull(),
    low: numeric('low', { precision: 12, scale: 2 }).notNull(),
    close: numeric('close', { precision: 12, scale: 2 }).notNull(),
    volume: numeric('volume', { precision: 16, scale: 4 }).notNull(),
    dvol: numeric('dvol', { precision: 6, scale: 2 }),
    rv: numeric('rv', { precision: 6, scale: 2 }),
    atmIv: numeric('atm_iv', { precision: 6, scale: 2 }),
    openInterest: numeric('open_interest', { precision: 16, scale: 4 }),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.interval, table.time] }),
  ]
);

/**
 * 11. Indicator Snapshots (5-Minute Interval Recordings)
 * 
 * Replaces IndexedDB `suraj_ind_v1` (store 'rows') and `suraj_archive_v1`.
 * Used by Season and Day Coach (v136/v139) to grade historical nights by weekday.
 * Matches the exact fields and shapes recorded in the original prototype:
 * - t / recordedAt: 5-min boundary timestamp
 * - tc: Term spread (Current - N2N IV)
 * - tn: Term spread (Next - N2N IV)
 * - fwd: Forward volatility between expiries
 * - n2n: N2N reference IV
 * - rr: 25-delta risk reversal skew (put IV - call IV)
 * - fly: 25-delta butterfly
 * - se / masterExpiry: master expiry code
 * - satm: ATM IV of master expiry
 * - fund: Delta BTCUSD perpetual funding rate
 * - oi: Open interest
 * - liqL / liqS: OKX swaps liquidation volume for longs and shorts (USD)
 */
export const indicatorSnapshots = pgTable(
  'indicator_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(), // 't'
    symbol: varchar('symbol', { length: 20 }).default('BTCUSDT').notNull(),
    termCurrentN2n: numeric('term_current_n2n', { precision: 16, scale: 4 }), // 'tc' (Cur - N2N)
    termNextN2n: numeric('term_next_n2n', { precision: 16, scale: 4 }), // 'tn' (Next - N2N)
    forwardVol: numeric('forward_vol', { precision: 16, scale: 4 }), // 'fwd'
    n2nIv: numeric('n2n_iv', { precision: 16, scale: 4 }), // 'n2n'
    skew25Delta: numeric('skew_25d', { precision: 20, scale: 4 }), // 'rr' (25Δ put - call IV or GEX net USD)
    butterfly: numeric('butterfly', { precision: 16, scale: 4 }), // 'fly'
    masterExpiry: varchar('master_expiry', { length: 20 }), // 'se'
    atmIv: numeric('atm_iv', { precision: 16, scale: 4 }), // 'satm'
    fundingRate: numeric('funding_rate', { precision: 12, scale: 6 }), // 'fund' (perp funding)
    openInterest: numeric('open_interest', { precision: 20, scale: 4 }), // 'oi'
    liquidationLongsUsd: numeric('liquidation_longs_usd', { precision: 20, scale: 4 }), // 'liqL'
    liquidationShortsUsd: numeric('liquidation_shorts_usd', { precision: 20, scale: 4 }), // 'liqS'
    rawSnapshot: jsonb('raw_snapshot'), // Full raw legacy object for lossless migration
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('indicator_snapshots_symbol_time_idx').on(table.symbol, table.recordedAt),
  ]
);

/**
 * 12. Option Flow Buckets (15-Minute Aggregations)
 * 
 * Replaces IndexedDB `suraj_archive_v1` (store 'flow').
 * Stores historical and live aggregated Deribit options flow telemetry.
 * Captures 15-minute buy/sell volume distributions across calls and puts,
 * along with block trade activity and executed trade count.
 */
export const optionFlowBuckets = pgTable(
  'option_flow_buckets',
  {
    time: timestamp('time', { withTimezone: true }).notNull(), // 15-minute bucket start timestamp ('t')
    symbol: varchar('symbol', { length: 20 }).default('BTC').notNull(),
    callSellVol: numeric('call_sell_vol', { precision: 16, scale: 4 }).default('0').notNull(), // side[0]
    callBuyVol: numeric('call_buy_vol', { precision: 16, scale: 4 }).default('0').notNull(),   // side[1]
    putSellVol: numeric('put_sell_vol', { precision: 16, scale: 4 }).default('0').notNull(),   // side[2]
    putBuyVol: numeric('put_buy_vol', { precision: 16, scale: 4 }).default('0').notNull(),     // side[3]
    blockCallSellVol: numeric('block_call_sell_vol', { precision: 16, scale: 4 }).default('0'), // blk[0]
    blockCallBuyVol: numeric('block_call_buy_vol', { precision: 16, scale: 4 }).default('0'),   // blk[1]
    blockPutSellVol: numeric('block_put_sell_vol', { precision: 16, scale: 4 }).default('0'),   // blk[2]
    blockPutBuyVol: numeric('block_put_buy_vol', { precision: 16, scale: 4 }).default('0'),     // blk[3]
    tradeCount: integer('trade_count').default(0).notNull(), // 'n'
    rawFlow: jsonb('raw_flow'), // Raw bucket object for lossless fidelity
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.symbol, table.time] }),
  ]
);

/**
 * 13. Session Telemetry & Self-Testing Audit Logs
 * 
 * Automatically records every trading session (traded or skipped):
 * - Entry / exit timestamps
 * - Option premiums per leg (bid/ask/mark)
 * - Strike deltas
 * - Speed vs IV reading
 * - Day of week & sizing used
 * - Realized P&L & stop/win outcome
 * - Exact Calendar/Clock/Speed state the UI displayed
 * - Self-testing verification: flags immediately if live display ever diverged from locked rule.
 */
export const sessionAuditLogs = pgTable('session_audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sessionDate: date('session_date').notNull(),
  dayOfWeek: integer('day_of_week').notNull(), // 0 = Sun, 1 = Mon, ..., 6 = Sat
  dayName: varchar('day_name', { length: 10 }).notNull(), // 'Mon', 'Tue', etc.
  sessionStatus: varchar('session_status', { length: 20 }).notNull(), // 'TRADED' | 'SKIPPED'
  entryTime: timestamp('entry_time', { withTimezone: true }),
  exitTime: timestamp('exit_time', { withTimezone: true }),
  callStrike: numeric('call_strike', { precision: 12, scale: 2 }),
  putStrike: numeric('put_strike', { precision: 12, scale: 2 }),
  callDelta: numeric('call_delta', { precision: 6, scale: 4 }),
  putDelta: numeric('put_delta', { precision: 6, scale: 4 }),
  callEntryPremium: numeric('call_entry_premium', { precision: 12, scale: 2 }),
  putEntryPremium: numeric('put_entry_premium', { precision: 12, scale: 2 }),
  callExitPremium: numeric('call_exit_premium', { precision: 12, scale: 2 }),
  putExitPremium: numeric('put_exit_premium', { precision: 12, scale: 2 }),
  speedVsIv: numeric('speed_vs_iv', { precision: 6, scale: 3 }),
  sizing: numeric('sizing', { precision: 4, scale: 2 }).default('0').notNull(), // 0.0, 0.5, 1.0
  realizedPnl: numeric('realized_pnl', { precision: 12, scale: 2 }),
  outcome: varchar('outcome', { length: 20 }).default('SKIPPED').notNull(), // 'WIN' | 'STOP' | 'SKIPPED' | 'SCRATCH'
  uiState: jsonb('ui_state').notNull(), // { calendarDay, clockWindow, speedBeacon, goSignal, statusWord }
  ruleState: jsonb('rule_state').notNull(), // { expectedCalendar, expectedWindow, expectedSpeed, expectedGo, expectedSizing }
  telemetryMatch: boolean('telemetry_match').default(true).notNull(), // true if UI perfectly matched rule
  mismatchReason: text('mismatch_reason'), // null if match, or description of discrepancy
  meta: jsonb('meta').default('{}'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 14. Recalibration Audits (Automated Bonferroni & OOS Re-runs)
 * 
 * Periodically re-tests the growing dataset against the Bonferroni bar
 * and 50/50 walk-forward split to ensure edge remains robust and flag any decay.
 */
export const recalibrationAudits = pgTable('recalibration_audits', {
  id: uuid('id').primaryKey().defaultRandom(),
  runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
  totalSessions: integer('total_sessions').notNull(),
  inSampleSessions: integer('in_sample_sessions').notNull(),
  outOfSampleSessions: integer('out_of_sample_sessions').notNull(),
  bonferroniAlpha: numeric('bonferroni_alpha', { precision: 8, scale: 6 }).notNull(),
  tueWedStopRate: numeric('tue_wed_stop_rate', { precision: 6, scale: 2 }),
  speedStopRate: numeric('speed_stop_rate', { precision: 6, scale: 2 }),
  comboStopRate: numeric('combo_stop_rate', { precision: 6, scale: 2 }),
  comboPValue: numeric('combo_p_value', { precision: 8, scale: 6 }),
  clearedBonferroni: boolean('cleared_bonferroni').notNull(),
  oosStopRate: numeric('oos_stop_rate', { precision: 6, scale: 2 }),
  oosStabilityVerdict: varchar('oos_stability_verdict', { length: 30 }).notNull(), // 'STABLE' | 'DECAYING' | 'ENHANCED'
  auditSummary: jsonb('audit_summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});


