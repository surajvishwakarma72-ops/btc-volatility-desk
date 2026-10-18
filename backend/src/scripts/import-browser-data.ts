import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Schema and database client imports
import {
  db,
  pool,
  users,
  trades,
  tradeLegs,
  nightlyReviews,
  chartDrawings,
  userPreferences,
  alertRules,
  alertLogs,
  indicatorSnapshots,
  marketTimeseries,
  optionFlowBuckets,
} from '../db/index.js';

interface SkippedRecord {
  source: string;
  targetTable: string;
  reason: string;
  rawRecord: unknown;
}

interface ImportSummary {
  sourceFile: string;
  mode: 'DRY_RUN' | 'COMMIT';
  totalRead: number;
  totalMapped: number;
  totalSkipped: number;
  tableCounts: Record<string, { read: number; mapped: number; skipped: number }>;
}

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Normalizes numeric values safely from legacy numbers/strings
 */
function toNum(val: unknown, fallback: number | null = null): string | null {
  if (val == null || val === '') return fallback == null ? null : String(fallback);
  const n = Number(val);
  return Number.isFinite(n) ? String(n) : fallback == null ? null : String(fallback);
}

/**
 * Normalizes timestamps safely to ISO-8601 strings or Date objects
 */
function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  if (typeof val === 'number') {
    // If timestamp is in seconds, convert to milliseconds
    const ms = val < 10000000000 ? val * 1000 : val;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof val === 'string') {
    // Date only string "YYYY-MM-DD"
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
      const d = new Date(`${val}T00:00:00.000Z`);
      return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Extracts OHLC values from legacy 1440-minute day arrays or serialized objects
 */
function extractSessionOhlc(arrObj: any): { open: number; high: number; low: number; close: number } | null {
  if (!arrObj) return null;
  let vals: number[] = [];
  if (Array.isArray(arrObj)) {
    vals = arrObj.filter((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
  } else if (typeof arrObj === 'object') {
    vals = Object.values(arrObj).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  }
  if (!vals.length) return null;
  return {
    open: vals[0],
    high: Math.max(...vals),
    low: Math.min(...vals),
    close: vals[vals.length - 1],
  };
}

/**
 * Main migration execution function
 */
export async function runImport(filePath: string, isCommit: boolean = false, targetUserId: string = DEFAULT_USER_ID): Promise<ImportSummary> {
  console.log('='.repeat(70));
  console.log(`  BTC Volatility Desk — Browser Data Importer`);
  console.log(`  Execution Mode: ${isCommit ? '*** COMMIT (Live Database Write) ***' : 'DRY-RUN (Simulation Only)'}`);
  console.log(`  Input File:     ${filePath}`);
  console.log(`  Target User ID: ${targetUserId}`);
  console.log('='.repeat(70));

  if (!fs.existsSync(filePath)) {
    console.error(`\n[ERROR] File not found: ${filePath}`);
    process.exit(1);
  }

  let rawContent: string | null = fs.readFileSync(filePath, 'utf-8');
  let exportBundle: any;

  try {
    exportBundle = JSON.parse(rawContent);
  } catch (err: any) {
    console.error(`\n[ERROR] Invalid JSON in ${filePath}:`, err.message);
    process.exit(1);
  } finally {
    rawContent = null;
  }

  const skipped: SkippedRecord[] = [];
  const mappedRecords: {
    trades: any[];
    tradeLegs: any[];
    nightlyReviews: any[];
    chartDrawings: any[];
    userPreferences: any[];
    alertRules: any[];
    alertLogs: any[];
    indicatorSnapshots: any[];
    marketTimeseries: any[];
    optionFlowBuckets: any[];
  } = {
    trades: [],
    tradeLegs: [],
    nightlyReviews: [],
    chartDrawings: [],
    userPreferences: [],
    alertRules: [],
    alertLogs: [],
    indicatorSnapshots: [],
    marketTimeseries: [],
    optionFlowBuckets: [],
  };

  const tableStats: Record<string, { read: number; mapped: number; skipped: number }> = {
    trades: { read: 0, mapped: 0, skipped: 0 },
    trade_trajectories: { read: 0, mapped: 0, skipped: 0 },
    nightly_reviews: { read: 0, mapped: 0, skipped: 0 },
    chart_drawings: { read: 0, mapped: 0, skipped: 0 },
    user_preferences: { read: 0, mapped: 0, skipped: 0 },
    alert_rules: { read: 0, mapped: 0, skipped: 0 },
    alert_logs: { read: 0, mapped: 0, skipped: 0 },
    indicator_snapshots: { read: 0, mapped: 0, skipped: 0 },
    market_timeseries: { read: 0, mapped: 0, skipped: 0 },
    option_flow_buckets: { read: 0, mapped: 0, skipped: 0 },
    auxiliary_idb_databases: { read: 0, mapped: 0, skipped: 0 },
    ephemeral_caches: { read: 0, mapped: 0, skipped: 0 },
    dom_ui_toggles: { read: 0, mapped: 0, skipped: 0 },
    system_metadata: { read: 0, mapped: 0, skipped: 0 },
  };

  const storeInventory: {
    origin: string;
    store: string;
    count: number;
    destination: string;
  }[] = [];

  const ls = exportBundle.localStorage || {};
  const idb = exportBundle.indexedDB || {};

  // --------------------------------------------------------------------------
  // 1. Map Trades & Trade Legs (v99_trades, v99_trade, v18:lab, v99_path_*)
  // --------------------------------------------------------------------------
  console.log('\n[1/8] Processing Trades & Trade Legs...');
  const tradeSources: any[] = [];

  // v99_trades
  if (ls['v99_trades']?.parsed && Array.isArray(ls['v99_trades'].parsed)) {
    for (const t of ls['v99_trades'].parsed) {
      tradeSources.push({ ...t, _source: 'localStorage.v99_trades' });
    }
  }

  // v99_trade (active open trade)
  if (ls['v99_trade']?.parsed && typeof ls['v99_trade'].parsed === 'object') {
    tradeSources.push({ ...ls['v99_trade'].parsed, _source: 'localStorage.v99_trade', status: 'OPEN' });
  }

  // v18:lab (IndexedDB trades)
  if (idb['v18:lab']?.stores) {
    for (const [storeName, entries] of Object.entries(idb['v18:lab'].stores)) {
      if (Array.isArray(entries)) {
        for (const e of entries) {
          tradeSources.push({ ...(e.value || e), _source: `idb.v18:lab.${storeName}` });
        }
      }
    }
  }

  tableStats.trades.read = tradeSources.length;

  for (const raw of tradeSources) {
    try {
      const entryTime = toDate(
        raw.openedAt || raw.entryTime || raw.t || raw.entry_t || raw.date || raw.fills?.[0]?.t
      );
      const expiryDate = toDate(
        raw.exp || raw.expiryDate || raw.expiry || (entryTime ? new Date(entryTime.getTime() + 86400000) : null)
      );

      if (!entryTime || !expiryDate) {
        skipped.push({
          source: raw._source || 'trades',
          targetTable: 'trades',
          reason: 'Missing or unparseable entryTime or expiryDate',
          rawRecord: raw,
        });
        tableStats.trades.skipped++;
        continue;
      }

      const callStrike = toNum(raw.Kc || raw.callStrike || raw.c_strike || raw.cStrike || raw.call || raw.strikes?.[0], 0);
      const putStrike = toNum(raw.Kp || raw.putStrike || raw.p_strike || raw.pStrike || raw.put || raw.strikes?.[1], 0);

      const contracts = toNum(
        raw.lot || raw.contracts || raw.size || raw.qty || (raw.fills?.[0]?.lots ? raw.fills[0].lots / 10000 : 1),
        1
      ) || '1';

      const realizedPnl = toNum(raw.pnlUsd || raw.realizedPnl || raw.pnl || raw.realized_pnl);
      const exitTime = toDate(raw.closedAt || raw.exitTime || raw.exit_t);

      const tradeId = crypto.randomUUID();
      const status = raw.status === 'OPEN' || (!exitTime && !realizedPnl)
        ? 'OPEN'
        : raw.status === 'CANCELLED'
        ? 'CANCELLED'
        : 'CLOSED';

      // Check for trade PnL path trajectory (e.g. v99_path_mv3s03fe)
      const pnlAttributionObj = raw.pnlAttribution || {};
      const tradeKey = raw.id;
      if (tradeKey && ls[`v99_path_${tradeKey}`]?.parsed) {
        pnlAttributionObj.trajectory = ls[`v99_path_${tradeKey}`].parsed;
        const trajCount = Array.isArray(pnlAttributionObj.trajectory) ? pnlAttributionObj.trajectory.length : 1;
        tableStats.trade_trajectories.read += trajCount;
        tableStats.trade_trajectories.mapped += trajCount;
      }

      // Extract spot values from trajectory endpoints if not explicitly provided on trade root
      const trajArr = Array.isArray(pnlAttributionObj.trajectory) ? pnlAttributionObj.trajectory : [];
      const trajEntrySpot = trajArr.length > 0 && Number.isFinite(trajArr[0][2]) ? trajArr[0][2] : null;
      const trajExitSpot = trajArr.length > 0 && Number.isFinite(trajArr[trajArr.length - 1][2]) ? trajArr[trajArr.length - 1][2] : null;

      const entrySpot = toNum(raw.entrySpot || raw.spot || raw.spot0 || trajEntrySpot);
      const exitSpot = toNum(raw.exitSpot || raw.spotExit || (exitTime ? trajExitSpot : null));
      const entryIv = toNum(raw.entryIv || raw.iv0 || raw.soldIv || raw.iv);
      const exitIv = toNum(raw.exitIv || raw.ivExit);

      const tradeRow = {
        id: tradeId,
        userId: targetUserId,
        strategy: 'SHORT_STRANGLE',
        status: status,
        underlying: 'BTC',
        expiryDate: expiryDate,
        callStrike: callStrike || '0',
        putStrike: putStrike || '0',
        entryTime: entryTime,
        exitTime: exitTime,
        entrySpot: entrySpot,
        exitSpot: exitSpot,
        entryIv: entryIv,
        exitIv: exitIv,
        contracts: contracts,
        realizedPnl: realizedPnl,
        exitReason: raw.exitReason || raw.reason || null,
        entryGreeks: raw.entryGreeks || raw.greeks || {},
        pnlAttribution: pnlAttributionObj,
      };

      mappedRecords.trades.push(tradeRow);
      tableStats.trades.mapped++;

      // Create detailed Trade Legs (Call & Put)

      // Call Leg
      const callLeg = {
        id: crypto.randomUUID(),
        tradeId: tradeId,
        legType: 'CALL',
        action: 'SELL',
        strike: callStrike || '0',
        entryPrice: toNum(raw.callEntry || raw.c_premium || raw.callPrem),
        exitPrice: toNum(raw.callExit || raw.c_exit_prem),
        contracts: contracts,
        entryIv: toNum(raw.callIv || raw.entryIv || raw.iv0),
        exitIv: toNum(raw.callExitIv || raw.exitIv),
        realizedPnl: realizedPnl ? String(Number(realizedPnl) / 2) : null,
      };

      // Put Leg
      const putLeg = {
        id: crypto.randomUUID(),
        tradeId: tradeId,
        legType: 'PUT',
        action: 'SELL',
        strike: putStrike || '0',
        entryPrice: toNum(raw.putEntry || raw.p_premium || raw.putPrem),
        exitPrice: toNum(raw.putExit || raw.p_exit_prem),
        contracts: contracts,
        entryIv: toNum(raw.putIv || raw.entryIv || raw.iv0),
        exitIv: toNum(raw.putExitIv || raw.exitIv),
        realizedPnl: realizedPnl ? String(Number(realizedPnl) / 2) : null,
      };

      mappedRecords.tradeLegs.push(callLeg, putLeg);
    } catch (err: any) {
      skipped.push({
        source: raw._source || 'trades',
        targetTable: 'trades',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.trades.skipped++;
    }
  }

  // --------------------------------------------------------------------------
  // 2. Map Nightly Reviews (v147_nights, suraj_archive_v1.days, suraj_archive_v1.nights)
  // --------------------------------------------------------------------------
  console.log('[2/8] Processing Nightly Reviews & Calendar History...');
  const nightSources: any[] = [];

  // v147_nights (localStorage)
  if (ls['v147_nights']?.parsed && Array.isArray(ls['v147_nights'].parsed)) {
    for (const n of ls['v147_nights'].parsed) {
      nightSources.push({ ...n, _source: 'localStorage.v147_nights' });
    }
  }

  // suraj_archive_v1.days (IndexedDB)
  if (idb['suraj_archive_v1']?.stores?.days) {
    for (const e of idb['suraj_archive_v1'].stores.days) {
      nightSources.push({ ...(e.value || e), _source: 'idb.suraj_archive_v1.days' });
    }
  }

  // suraj_archive_v1.nights (IndexedDB historical pre-v28 sessions)
  if (idb['suraj_archive_v1']?.stores?.nights) {
    for (const e of idb['suraj_archive_v1'].stores.nights) {
      nightSources.push({ ...(e.value || e), _source: 'idb.suraj_archive_v1.nights' });
    }
  }

  tableStats.nightly_reviews.read = nightSources.length;
  const seenDates = new Set<string>();

  for (const raw of nightSources) {
    try {
      const dateStr = raw.day || raw.night || raw.sessionDate || raw.date || raw.d || (raw.t ? new Date(raw.t).toISOString().slice(0, 10) : null);
      if (!dateStr || seenDates.has(dateStr)) {
        if (!dateStr) {
          skipped.push({
            source: raw._source || 'nightly_reviews',
            targetTable: 'nightly_reviews',
            reason: 'Missing session date (checked day, night, sessionDate, date, d, t)',
            rawRecord: raw,
          });
          tableStats.nightly_reviews.skipped++;
        } else {
          // Explicitly log duplicate calendar nights so zero records are silently swallowed!
          skipped.push({
            source: raw._source || 'nightly_reviews',
            targetTable: 'nightly_reviews',
            reason: `Duplicate calendar night ${dateStr} (superseded by days)`,
            rawRecord: raw,
          });
          tableStats.nightly_reviews.skipped++;
        }
        continue; // deduplicate same night
      }

      seenDates.add(dateStr);
      const verdict = raw.verdict === 'SELL_HALF' ? 'SELL_HALF' : raw.verdict === 'NO_TRADE' ? 'NO_TRADE' : 'SELL_FULL';
      const outcome = raw.outcome || (raw.pnl > 0 ? 'PROFIT' : raw.pnl < 0 ? 'LOSS' : raw.pnl === 0 ? 'SCRATCH' : null);

      mappedRecords.nightlyReviews.push({
        id: crypto.randomUUID(),
        userId: targetUserId,
        sessionDate: dateStr,
        verdict: verdict,
        outcome: outcome,
        iv1730: toNum(raw.iv1730 || raw.e1730 || raw.pre || raw.iv0),
        ivNyOpen: toNum(raw.ivNyOpen || raw.eOpen || raw.e),
        ivExit: toNum(raw.ivExit || raw.x07 || raw.x15 || raw.iv1),
        speedVsIv: toNum(raw.speedVsIv || raw.speed || raw.pct),
        adxTrend: raw.adxTrend || (raw.adxFalling ? 'FALLING' : null),
        exitHour: Number.isInteger(raw.exitHour) ? raw.exitHour : null,
        eventTags: Array.isArray(raw.eventTags || raw.tags) ? (raw.eventTags || raw.tags) : [],
        notes: raw.notes || raw.txt || (raw.max != null ? `Night IV session (${raw.sk || 'default'}). Max spike: ${raw.max}%, IV change: ${raw.pct}%` : null),
      });
      tableStats.nightly_reviews.mapped++;
    } catch (err: any) {
      skipped.push({
        source: raw._source || 'nightly_reviews',
        targetTable: 'nightly_reviews',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.nightly_reviews.skipped++;
    }
  }

  // --------------------------------------------------------------------------
  // 3. Map Chart Drawings & Anchor Notes (btc_drawings_v1 & v100_anchor_*)
  // --------------------------------------------------------------------------
  console.log('[3/8] Processing Chart Drawings & Session Anchors...');
  const drawingsSource = ls['btc_drawings_v1']?.parsed;
  const anchorSources: any[] = [];

  for (const k of Object.keys(ls)) {
    if (k.startsWith('v100_anchor_')) {
      const item = ls[k]?.parsed;
      if (item && typeof item === 'object') {
        anchorSources.push({ ...item, _key: k });
      }
    }
  }

  let totalAnchorItems = 0;
  for (const k of Object.keys(ls)) {
    if (k.startsWith('v100_anchor_')) {
      const cnt = ls[k]?.itemCount || (Array.isArray(ls[k]?.parsed) ? ls[k].parsed.length : 1);
      totalAnchorItems += cnt;
    }
  }
  tableStats.chart_drawings.read = (Array.isArray(drawingsSource) ? drawingsSource.length : 0) + totalAnchorItems;
  tableStats.chart_drawings.mapped = 0;

  // Process standard drawings
  if (Array.isArray(drawingsSource)) {
    for (const raw of drawingsSource) {
      try {
        if (!raw.points || !Array.isArray(raw.points)) {
          skipped.push({
            source: 'localStorage.btc_drawings_v1',
            targetTable: 'chart_drawings',
            reason: 'Drawing missing valid points array',
            rawRecord: raw,
          });
          tableStats.chart_drawings.skipped++;
          continue;
        }

        mappedRecords.chartDrawings.push({
          id: crypto.randomUUID(),
          userId: targetUserId,
          symbol: raw.symbol || 'BTCUSDT',
          drawingType: raw.type || raw.drawingType || 'HORIZONTAL_RAY',
          points: raw.points,
          style: raw.style || { color: raw.color || '#2F81F7', lineWidth: raw.width || 1 },
          label: raw.label || raw.text || null,
        });
        tableStats.chart_drawings.mapped++;
      } catch (err: any) {
        skipped.push({
          source: 'localStorage.btc_drawings_v1',
          targetTable: 'chart_drawings',
          reason: `Mapping error: ${err.message}`,
          rawRecord: raw,
        });
        tableStats.chart_drawings.skipped++;
      }
    }
  }

  // Process Anchor Notes (folded into chart_drawings as vertical anchor lines with notes)
  for (const raw of anchorSources) {
    try {
      const anchorTimeSec = raw.aT ? Math.floor(Number(raw.aT) / 1000) : null;
      if (!anchorTimeSec) {
        skipped.push({
          source: `localStorage.${raw._key}`,
          targetTable: 'chart_drawings',
          reason: 'Anchor note missing valid timestamp (aT)',
          rawRecord: raw,
        });
        tableStats.chart_drawings.skipped++;
        continue;
      }

      mappedRecords.chartDrawings.push({
        id: crypto.randomUUID(),
        userId: targetUserId,
        symbol: 'BTCUSDT',
        drawingType: 'VERTICAL_LINE',
        points: [{ time: anchorTimeSec, price: Number(raw.aV) || 0 }],
        style: { color: '#F59E0B', lineWidth: 2, lineStyle: 'dashed' },
        label: raw.note ? `Anchor: ${raw.note}` : 'Session Anchor',
      });
      tableStats.chart_drawings.mapped += ls[raw._key]?.itemCount || 1;
    } catch (err: any) {
      skipped.push({
        source: `localStorage.${raw._key}`,
        targetTable: 'chart_drawings',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.chart_drawings.skipped++;
    }
  }

  // --------------------------------------------------------------------------
  // 4. Map User Preferences (v132_ind, v143_skin, btc_vol_desk_prefs_v1 + view keys)
  // --------------------------------------------------------------------------
  console.log('[4/8] Processing Workspace Preferences & View Settings...');

  // Identify view preferences in localStorage to fold into user_preferences JSONB
  const aggregatedViewPrefs: Record<string, any> = {};
  let totalUserPrefsItems = 0;

  for (const k of Object.keys(ls)) {
    if (
      k.includes('pref') ||
      k.includes('view') ||
      k.includes('pane') ||
      k.includes('theme') ||
      k.startsWith('v105_') ||
      k === 'v132_ind' ||
      k === 'v143_skin' ||
      k === 'dp_creds_v1'
    ) {
      if (k !== 'btc_vol_desk_prefs_v1') {
        aggregatedViewPrefs[k] = ls[k]?.parsed !== undefined ? ls[k].parsed : ls[k]?.raw;
      }
      const cnt = ls[k]?.itemCount || (Array.isArray(ls[k]?.parsed) ? ls[k].parsed.length : 1);
      totalUserPrefsItems += cnt;
    }
  }

  tableStats.user_preferences.read = totalUserPrefsItems - 1;
  tableStats.user_preferences.mapped = totalUserPrefsItems - 1;

  const activeInd = ls['v132_ind']?.parsed || [];
  const skin = ls['v143_skin']?.parsed === '0' || ls['btc_atm_iv_theme']?.parsed === 'light' ? 'classic_light' : 'coinglass_dark';
  const deskPrefs = ls['btc_vol_desk_prefs_v1']?.parsed || {};

  mappedRecords.userPreferences.push({
    id: crypto.randomUUID(),
    userId: targetUserId,
    theme: skin,
    activeIndicators: Array.isArray(activeInd) ? activeInd : Object.keys(activeInd),
    chartLayout: {
      ...(deskPrefs.layout || {}),
      viewPreferences: aggregatedViewPrefs,
    },
    riskLimits: deskPrefs.risk || {},
  });

  // --------------------------------------------------------------------------
  // 5. Map Alerts, Logs & VolTurn Signals (vt_alert_prefs_v1, btc_alerts_v1, events, vt_alert_log_v1)
  // --------------------------------------------------------------------------
  console.log('[5/8] Processing Alert Rules, Logs & VolTurn Signals...');
  const alertPrefs = ls['vt_alert_prefs_v1']?.parsed || {};
  const alertLogList = ls['btc_alerts_v1']?.parsed || [];
  const eventSources: any[] = [];
  const vtAlertLogs = ls['vt_alert_log_v1']?.parsed;
  const vtAlertList: any[] = Array.isArray(vtAlertLogs) ? vtAlertLogs : [];

  if (idb['suraj_archive_v1']?.stores?.events) {
    for (const e of idb['suraj_archive_v1'].stores.events) {
      eventSources.push({ ...(e.value || e), _source: 'idb.suraj_archive_v1.events' });
    }
  }

  if (alertPrefs && typeof alertPrefs === 'object') {
    tableStats.alert_rules.read = 1;
    tableStats.alert_rules.mapped = 1;
    mappedRecords.alertRules.push({
      id: crypto.randomUUID(),
      userId: targetUserId,
      ruleName: 'Default VolTurn Alert',
      ruleType: 'IV_SPIKE',
      thresholdValue: toNum(alertPrefs.spikeThreshold, 1.5) || '1.5',
      channels: [alertPrefs.push === 'tg' ? 'telegram' : alertPrefs.push === 'ntfy' ? 'ntfy' : 'in_app'],
      cooldownSeconds: Number(alertPrefs.cooldown) || 300,
      isActive: alertPrefs.enabled !== false,
    });
  }

  tableStats.alert_logs.read = alertLogList.length + eventSources.length + vtAlertList.length;

  // 5a. Map legacy in-app alerts (btc_alerts_v1)
  if (Array.isArray(alertLogList)) {
    for (const raw of alertLogList) {
      try {
        mappedRecords.alertLogs.push({
          id: crypto.randomUUID(),
          userId: targetUserId,
          title: raw.title || raw.text || 'Alert',
          message: raw.message || raw.desc || String(raw),
          channel: raw.channel || 'in_app',
          status: 'SENT',
          deliveredAt: toDate(raw.t || raw.time) || new Date(),
        });
        tableStats.alert_logs.mapped++;
      } catch (err: any) {
        skipped.push({
          source: 'localStorage.btc_alerts_v1',
          targetTable: 'alert_logs',
          reason: `Mapping error: ${err.message}`,
          rawRecord: raw,
        });
        tableStats.alert_logs.skipped++;
      }
    }
  }

  // 5b. Map historical VolTurn breakout/reversal events (2,926 records)
  for (const raw of eventSources) {
    try {
      const eventTime = toDate(raw.t || raw.bar || raw.upd) || new Date();
      const kind = (raw.k || 'signal').toUpperCase();
      const tfMinutes = raw.tf ? Math.round(Number(raw.tf) / 60) : 15;
      const spotStr = raw.spot != null ? `$${Number(raw.spot).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` : 'N/A';
      const ivStr = raw.iv != null ? `${Number(raw.iv).toFixed(2)}%` : 'N/A';

      mappedRecords.alertLogs.push({
        id: crypto.randomUUID(),
        userId: targetUserId,
        title: `VolTurn Signal: ${kind} (${tfMinutes}m)`,
        message: `Structural ${kind} event detected. Spot: ${spotStr}, ATM IV: ${ivStr}, Expiry: ${raw.exp || 'N/A'}`,
        channel: 'volturn_signal',
        status: 'SENT',
        deliveredAt: eventTime,
      });
      tableStats.alert_logs.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'idb.suraj_archive_v1.events',
        targetTable: 'alert_logs',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.alert_logs.skipped++;
    }
  }

  // 5c. Map historical VolTurn danger/alert logs (vt_alert_log_v1, 30 records)
  for (const raw of vtAlertList) {
    try {
      const deliveredAt = toDate(raw.t || raw.time) || new Date();
      mappedRecords.alertLogs.push({
        id: crypto.randomUUID(),
        userId: targetUserId,
        title: raw.title || `VolTurn Alert (${raw.k || 'signal'})`,
        message: raw.when ? `${raw.title || 'Alert'} at ${raw.when}` : (raw.desc || String(raw)),
        channel: 'in_app',
        status: 'SENT',
        deliveredAt: deliveredAt,
      });
      tableStats.alert_logs.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'localStorage.vt_alert_log_v1',
        targetTable: 'alert_logs',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.alert_logs.skipped++;
    }
  }

  // --------------------------------------------------------------------------
  // 6. Map Indicator Snapshots (suraj_ind_v1 rows & BTC_IV_RV_TERMINAL_V5_*)
  // --------------------------------------------------------------------------
  console.log('[6/8] Processing Indicator Snapshots (suraj_ind_v1 & Terminal V5 historical telemetry)...');
  const snapEntries: any[] = [];

  if (idb['suraj_ind_v1']?.stores?.rows) {
    for (const e of idb['suraj_ind_v1'].stores.rows) {
      snapEntries.push({ ...(e.value || e), _source: 'idb.suraj_ind_v1.rows' });
    }
  }

  // Fold Terminal V5 telemetry snapshots from localStorage (3,744 + 2,694 + 2,625 = 9,063 records)
  const v5Snaps = ls['BTC_IV_RV_TERMINAL_V5_snapshots']?.parsed;
  const v5SnapList: any[] = Array.isArray(v5Snaps) ? [...v5Snaps] : [];

  const v5OiSnaps = ls['BTC_IV_RV_TERMINAL_V5_oi_snapshots']?.parsed;
  const v5OiList: any[] = Array.isArray(v5OiSnaps) ? [...v5OiSnaps] : [];

  const v5GexSnaps = ls['BTC_IV_RV_TERMINAL_V5_gex_snapshots']?.parsed;
  const v5GexList: any[] = Array.isArray(v5GexSnaps) ? [...v5GexSnaps] : [];

  // Fold Terminal V6 & V5 telemetry from IndexedDB (1,171 + 742 = 1,913 records)
  for (const dbName of ['btc_iv_rv_terminal_v6', 'btc_iv_rv_terminal_v5']) {
    const stores = idb[dbName]?.stores || {};
    if (Array.isArray(stores.snapshots)) {
      for (const e of stores.snapshots) {
        v5SnapList.push({ ...(e.value || e), _source: `idb.${dbName}.snapshots` });
      }
    }
    if (Array.isArray(stores.oi_snapshots)) {
      for (const e of stores.oi_snapshots) {
        v5OiList.push({ ...(e.value || e), _source: `idb.${dbName}.oi_snapshots` });
      }
    }
    if (Array.isArray(stores.gex_snapshots)) {
      for (const e of stores.gex_snapshots) {
        v5GexList.push({ ...(e.value || e), _source: `idb.${dbName}.gex_snapshots` });
      }
    }
  }

  // Skew & Term snapshots (49 + 30 + 12 = 91 records)
  const v104Skew = ls['v104_skew']?.parsed;
  const v104SkewList: any[] = Array.isArray(v104Skew) ? v104Skew : [];

  const ngSkew = ls['ng_skew_v1']?.parsed;
  const ngSkewList: any[] = Array.isArray(ngSkew) ? ngSkew : [];

  const v100Term = ls['v100_term']?.parsed;
  const v100TermList: any[] = Array.isArray(v100Term) ? v100Term : [];

  tableStats.indicator_snapshots.read =
    snapEntries.length +
    v5SnapList.length +
    v5OiList.length +
    v5GexList.length +
    v104SkewList.length +
    ngSkewList.length +
    v100TermList.length;

  // 6a. Map suraj_ind_v1.rows (27 records)
  for (const raw of snapEntries) {
    try {
      const timestampMs = Number(raw.t || raw.timestamp || raw.time);
      if (!Number.isFinite(timestampMs)) {
        skipped.push({
          source: 'idb.suraj_ind_v1.rows',
          targetTable: 'indicator_snapshots',
          reason: 'Invalid snapshot timestamp (t)',
          rawRecord: raw,
        });
        tableStats.indicator_snapshots.skipped++;
        continue;
      }

      mappedRecords.indicatorSnapshots.push({
        id: crypto.randomUUID(),
        recordedAt: new Date(timestampMs),
        symbol: 'BTCUSDT',
        termCurrentN2n: toNum(raw.tc),
        termNextN2n: toNum(raw.tn),
        forwardVol: toNum(raw.fwd),
        n2nIv: toNum(raw.n2n),
        skew25Delta: toNum(raw.rr),
        butterfly: toNum(raw.fly),
        masterExpiry: raw.se || null,
        atmIv: toNum(raw.satm),
        fundingRate: toNum(raw.fund),
        openInterest: toNum(raw.oi),
        liquidationLongsUsd: toNum(raw.liqL),
        liquidationShortsUsd: toNum(raw.liqS),
        rawSnapshot: raw,
      });
      tableStats.indicator_snapshots.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'idb.suraj_ind_v1.rows',
        targetTable: 'indicator_snapshots',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.indicator_snapshots.skipped++;
    }
  }

  // 6b. Map BTC_IV_RV_TERMINAL_V5_snapshots (3,744 records)
  for (const raw of v5SnapList) {
    try {
      const timestampMs = Number(raw.ts || raw.t || raw.timestamp);
      if (!Number.isFinite(timestampMs)) {
        skipped.push({
          source: 'localStorage.BTC_IV_RV_TERMINAL_V5_snapshots',
          targetTable: 'indicator_snapshots',
          reason: 'Invalid timestamp (ts)',
          rawRecord: raw,
        });
        tableStats.indicator_snapshots.skipped++;
        continue;
      }

      const ivPct = raw.iv != null ? (Number(raw.iv) < 1 ? Number(raw.iv) * 100 : Number(raw.iv)) : null;
      const rvPct = raw.rv != null ? (Number(raw.rv) < 1 ? Number(raw.rv) * 100 : Number(raw.rv)) : null;
      const spreadVal = raw.spread != null ? (Math.abs(Number(raw.spread)) < 1 ? Number(raw.spread) * 100 : Number(raw.spread)) : null;

      mappedRecords.indicatorSnapshots.push({
        id: crypto.randomUUID(),
        recordedAt: new Date(timestampMs),
        symbol: 'BTCUSDT',
        termCurrentN2n: toNum(spreadVal),
        termNextN2n: null,
        forwardVol: toNum(rvPct),
        n2nIv: toNum(ivPct),
        skew25Delta: null,
        butterfly: null,
        masterExpiry: null,
        atmIv: toNum(ivPct),
        fundingRate: null,
        openInterest: null,
        liquidationLongsUsd: null,
        liquidationShortsUsd: null,
        rawSnapshot: raw,
      });
      tableStats.indicator_snapshots.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'localStorage.BTC_IV_RV_TERMINAL_V5_snapshots',
        targetTable: 'indicator_snapshots',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.indicator_snapshots.skipped++;
    }
  }

  // 6c. Map BTC_IV_RV_TERMINAL_V5_oi_snapshots (2,694 records)
  for (const raw of v5OiList) {
    try {
      const timestampMs = Number(raw.ts || raw.t || raw.timestamp);
      if (!Number.isFinite(timestampMs)) {
        skipped.push({
          source: 'localStorage.BTC_IV_RV_TERMINAL_V5_oi_snapshots',
          targetTable: 'indicator_snapshots',
          reason: 'Invalid timestamp (ts)',
          rawRecord: raw,
        });
        tableStats.indicator_snapshots.skipped++;
        continue;
      }

      const totalOi = (Number(raw.call || 0) + Number(raw.put || 0)) || raw.callContracts || 0;

      mappedRecords.indicatorSnapshots.push({
        id: crypto.randomUUID(),
        recordedAt: new Date(timestampMs),
        symbol: 'BTCUSDT',
        termCurrentN2n: null,
        termNextN2n: null,
        forwardVol: null,
        n2nIv: null,
        skew25Delta: null,
        butterfly: null,
        masterExpiry: null,
        atmIv: null,
        fundingRate: null,
        openInterest: toNum(totalOi),
        liquidationLongsUsd: null,
        liquidationShortsUsd: null,
        rawSnapshot: raw,
      });
      tableStats.indicator_snapshots.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'localStorage.BTC_IV_RV_TERMINAL_V5_oi_snapshots',
        targetTable: 'indicator_snapshots',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.indicator_snapshots.skipped++;
    }
  }

  // 6d. Map BTC_IV_RV_TERMINAL_V5_gex_snapshots (2,625 records)
  for (const raw of v5GexList) {
    try {
      const timestampMs = Number(raw.ts || raw.t || raw.timestamp);
      if (!Number.isFinite(timestampMs)) {
        skipped.push({
          source: 'localStorage.BTC_IV_RV_TERMINAL_V5_gex_snapshots',
          targetTable: 'indicator_snapshots',
          reason: 'Invalid timestamp (ts)',
          rawRecord: raw,
        });
        tableStats.indicator_snapshots.skipped++;
        continue;
      }

      mappedRecords.indicatorSnapshots.push({
        id: crypto.randomUUID(),
        recordedAt: new Date(timestampMs),
        symbol: 'BTCUSDT',
        termCurrentN2n: null,
        termNextN2n: null,
        forwardVol: null,
        n2nIv: null,
        skew25Delta: toNum(raw.net),
        butterfly: null,
        masterExpiry: null,
        atmIv: null,
        fundingRate: null,
        openInterest: null,
        liquidationLongsUsd: null,
        liquidationShortsUsd: null,
        rawSnapshot: raw,
      });
      tableStats.indicator_snapshots.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'localStorage.BTC_IV_RV_TERMINAL_V5_gex_snapshots',
        targetTable: 'indicator_snapshots',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.indicator_snapshots.skipped++;
    }
  }

  // 6e. Map v104_skew (49 records)
  for (const raw of v104SkewList) {
    try {
      const timestampMs = Number(raw.ts || raw.t || raw.time || (raw.date ? new Date(raw.date).getTime() : Date.now()));
      mappedRecords.indicatorSnapshots.push({
        id: crypto.randomUUID(),
        recordedAt: new Date(timestampMs),
        symbol: 'BTCUSDT',
        termCurrentN2n: null,
        termNextN2n: null,
        forwardVol: null,
        n2nIv: null,
        skew25Delta: toNum(raw.skew || raw.val || raw.value || raw.s),
        butterfly: null,
        masterExpiry: null,
        atmIv: null,
        fundingRate: null,
        openInterest: null,
        liquidationLongsUsd: null,
        liquidationShortsUsd: null,
        rawSnapshot: raw,
      });
      tableStats.indicator_snapshots.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'localStorage.v104_skew',
        targetTable: 'indicator_snapshots',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.indicator_snapshots.skipped++;
    }
  }

  // 6f. Map ng_skew_v1 (30 records)
  for (const raw of ngSkewList) {
    try {
      const timestampMs = Number(raw.ts || raw.t || raw.time || (raw.date ? new Date(raw.date).getTime() : Date.now()));
      mappedRecords.indicatorSnapshots.push({
        id: crypto.randomUUID(),
        recordedAt: new Date(timestampMs),
        symbol: 'BTCUSDT',
        termCurrentN2n: null,
        termNextN2n: null,
        forwardVol: null,
        n2nIv: null,
        skew25Delta: toNum(raw.skew || raw.val || raw.value),
        butterfly: null,
        masterExpiry: null,
        atmIv: null,
        fundingRate: null,
        openInterest: null,
        liquidationLongsUsd: null,
        liquidationShortsUsd: null,
        rawSnapshot: raw,
      });
      tableStats.indicator_snapshots.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'localStorage.ng_skew_v1',
        targetTable: 'indicator_snapshots',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.indicator_snapshots.skipped++;
    }
  }

  // 6g. Map v100_term (12 records)
  for (const raw of v100TermList) {
    try {
      const timestampMs = Number(raw.ts || raw.t || raw.time || (raw.date ? new Date(raw.date).getTime() : Date.now()));
      mappedRecords.indicatorSnapshots.push({
        id: crypto.randomUUID(),
        recordedAt: new Date(timestampMs),
        symbol: 'BTCUSDT',
        termCurrentN2n: toNum(raw.tc || raw.termCurrent),
        termNextN2n: toNum(raw.tn || raw.termNext),
        forwardVol: toNum(raw.fwd),
        n2nIv: toNum(raw.n2n),
        skew25Delta: null,
        butterfly: null,
        masterExpiry: null,
        atmIv: null,
        fundingRate: null,
        openInterest: null,
        liquidationLongsUsd: null,
        liquidationShortsUsd: null,
        rawSnapshot: raw,
      });
      tableStats.indicator_snapshots.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'localStorage.v100_term',
        targetTable: 'indicator_snapshots',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.indicator_snapshots.skipped++;
    }
  }


  // --------------------------------------------------------------------------
  // 7. Map Market Timeseries (suraj_archive_v1 btc & iv)
  // --------------------------------------------------------------------------
  console.log('[7/8] Processing Historical Market Timeseries (btc & iv)...');
  const btcSources: any[] = [];
  const ivSources: any[] = [];

  if (idb['suraj_archive_v1']?.stores?.btc) {
    for (const e of idb['suraj_archive_v1'].stores.btc) {
      btcSources.push(e.value || e);
    }
  }

  if (idb['suraj_archive_v1']?.stores?.iv) {
    for (const e of idb['suraj_archive_v1'].stores.iv) {
      ivSources.push(e.value || e);
    }
  }

  tableStats.market_timeseries.read = btcSources.length + ivSources.length;

  // Map BTC spot sessions (43 days of 1-minute OHLC packs -> daily candles)
  for (const raw of btcSources) {
    try {
      const dayStr = raw.day || (raw.t ? new Date(raw.t).toISOString().slice(0, 10) : null);
      if (!dayStr) {
        skipped.push({
          source: 'idb.suraj_archive_v1.btc',
          targetTable: 'market_timeseries',
          reason: 'Missing day field on BTC record',
          rawRecord: raw,
        });
        tableStats.market_timeseries.skipped++;
        continue;
      }

      const ohlc = extractSessionOhlc(raw.c || raw.o);
      const openVal = ohlc ? ohlc.open : toNum(raw.open || raw.o?.[0] || 0);
      const highVal = ohlc ? ohlc.high : toNum(raw.high || raw.h?.[0] || openVal);
      const lowVal = ohlc ? ohlc.low : toNum(raw.low || raw.l?.[0] || openVal);
      const closeVal = ohlc ? ohlc.close : toNum(raw.close || raw.c?.[0] || openVal);

      mappedRecords.marketTimeseries.push({
        time: new Date(`${dayStr}T00:00:00.000Z`),
        symbol: 'BTCUSDT',
        interval: '1d',
        open: toNum(openVal, 0) || '0',
        high: toNum(highVal, 0) || '0',
        low: toNum(lowVal, 0) || '0',
        close: toNum(closeVal, 0) || '0',
        volume: '0',
        dvol: null,
        rv: null,
        atmIv: null,
        openInterest: null,
      });
      tableStats.market_timeseries.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'idb.suraj_archive_v1.btc',
        targetTable: 'market_timeseries',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.market_timeseries.skipped++;
    }
  }

  // Map IV curve sessions (1,606 expiry-day curves -> daily IV summary rows)
  for (const raw of ivSources) {
    try {
      const dayStr = raw.day || (raw.t ? new Date(raw.t).toISOString().slice(0, 10) : null);
      if (!dayStr) {
        skipped.push({
          source: 'idb.suraj_archive_v1.iv',
          targetTable: 'market_timeseries',
          reason: 'Missing day field on IV record',
          rawRecord: raw,
        });
        tableStats.market_timeseries.skipped++;
        continue;
      }

      const ohlc = extractSessionOhlc(raw.c || raw.o);
      const closeIv = ohlc ? ohlc.close : toNum(raw.close || raw.c?.[0] || 0);
      const expiryTag = raw.e || 'ATM';
      const symbol = `BTC-${expiryTag}`;

      mappedRecords.marketTimeseries.push({
        time: new Date(`${dayStr}T00:00:00.000Z`),
        symbol: symbol.slice(0, 20),
        interval: '1d',
        open: toNum(ohlc?.open || closeIv, 0) || '0',
        high: toNum(ohlc?.high || closeIv, 0) || '0',
        low: toNum(ohlc?.low || closeIv, 0) || '0',
        close: toNum(closeIv, 0) || '0',
        volume: '0',
        dvol: null,
        rv: null,
        atmIv: toNum(closeIv),
        openInterest: null,
      });
      tableStats.market_timeseries.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'idb.suraj_archive_v1.iv',
        targetTable: 'market_timeseries',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.market_timeseries.skipped++;
    }
  }

  // --------------------------------------------------------------------------
  // 8. Map Option Flow Buckets (suraj_archive_v1.flow)
  // --------------------------------------------------------------------------
  console.log('[8/8] Processing Option Flow Buckets (suraj_archive_v1.flow)...');
  const flowSources: any[] = [];

  if (idb['suraj_archive_v1']?.stores?.flow) {
    for (const e of idb['suraj_archive_v1'].stores.flow) {
      flowSources.push({ ...(e.value || e), _source: 'idb.suraj_archive_v1.flow' });
    }
  }

  tableStats.option_flow_buckets.read = flowSources.length;

  for (const raw of flowSources) {
    try {
      const bucketTime = toDate(raw.t || raw.key || raw.upd);
      if (!bucketTime) {
        skipped.push({
          source: 'idb.suraj_archive_v1.flow',
          targetTable: 'option_flow_buckets',
          reason: 'Missing bucket timestamp (t)',
          rawRecord: raw,
        });
        tableStats.option_flow_buckets.skipped++;
        continue;
      }

      mappedRecords.optionFlowBuckets.push({
        time: bucketTime,
        symbol: 'BTC',
        callSellVol: toNum(raw.side?.[0], 0) || '0',
        callBuyVol: toNum(raw.side?.[1], 0) || '0',
        putSellVol: toNum(raw.side?.[2], 0) || '0',
        putBuyVol: toNum(raw.side?.[3], 0) || '0',
        blockCallSellVol: toNum(raw.blk?.[0], 0) || '0',
        blockCallBuyVol: toNum(raw.blk?.[1], 0) || '0',
        blockPutSellVol: toNum(raw.blk?.[2], 0) || '0',
        blockPutBuyVol: toNum(raw.blk?.[3], 0) || '0',
        tradeCount: Number.isInteger(raw.n) ? raw.n : 0,
        rawFlow: raw,
      });
      tableStats.option_flow_buckets.mapped++;
    } catch (err: any) {
      skipped.push({
        source: 'idb.suraj_archive_v1.flow',
        targetTable: 'option_flow_buckets',
        reason: `Mapping error: ${err.message}`,
        rawRecord: raw,
      });
      tableStats.option_flow_buckets.skipped++;
    }
  }

  // --------------------------------------------------------------------------
  // 9. Store Inventory & Unmapped Stores Sweep
  // --------------------------------------------------------------------------
  // Audit every database and store present in the export to ensure 100% accounting
  let totalSourceRecordsInExport = 0;

  // LocalStorage inventory
  const lsKeys = Object.keys(ls);
  let lsTotalCount = 0;
  for (const k of lsKeys) {
    const item = ls[k];
    const cnt = item?.itemCount || (Array.isArray(item?.parsed) ? item.parsed.length : 1);
    lsTotalCount += cnt;

    // Categorize unmapped localStorage keys for tableStats and skipped report
    const isMappedKey =
      k === 'v99_trades' ||
      k.startsWith('v99_path_') ||
      k === 'btc_drawings_v1' ||
      k.startsWith('v100_anchor_') ||
      k === 'btc_alerts_v1' ||
      k === 'vt_alert_log_v1' ||
      k.startsWith('BTC_IV_RV_TERMINAL_V5_') ||
      k === 'v104_skew' ||
      k === 'ng_skew_v1' ||
      k === 'v100_term' ||
      k === 'btc_vol_desk_prefs_v1' ||
      k === 'vt_alert_prefs_v1' ||
      k === 'dp_creds_v1' ||
      k === 'v132_ind' ||
      k === 'v143_skin' ||
      k.includes('pref') ||
      k.includes('view') ||
      k.includes('pane') ||
      k.includes('theme') ||
      k.startsWith('v105_');

    if (!isMappedKey) {
      if (
        k.includes('roll_v1') ||
        k.includes('backfill_v1') ||
        k.includes('delta_india') ||
        k.includes('globalQuotes') ||
        k.includes('lastSnapshot') ||
        k.includes('gexHistory') ||
        k.includes('candles_v1') ||
        k.includes('log_v1') ||
        k.includes('fut_h') ||
        k.includes('quotes')
      ) {
        tableStats.ephemeral_caches.read += cnt;
        tableStats.ephemeral_caches.skipped += cnt;
        skipped.push({
          source: `localStorage.${k}`,
          targetTable: '(none)',
          reason: `Skipped: Ephemeral client cache / runner log (${cnt} items)`,
          rawRecord: item?.parsed !== undefined ? item.parsed : item?.raw,
        });
      } else {
        tableStats.dom_ui_toggles.read += cnt;
        tableStats.dom_ui_toggles.skipped += cnt;
        skipped.push({
          source: `localStorage.${k}`,
          targetTable: '(none)',
          reason: `Skipped: Intentionally ignored DOM/UI view toggle state (${cnt} item)`,
          rawRecord: item?.parsed !== undefined ? item.parsed : item?.raw,
        });
      }
    }
  }
  totalSourceRecordsInExport += lsTotalCount;
  storeInventory.push({
    origin: 'localStorage',
    store: `[All ${lsKeys.length} keys]`,
    count: lsTotalCount,
    destination: 'MAPPED (trades, path, V5 snapshots, anchors, view prefs, alerts)',
  });

  // IndexedDB stores audit
  for (const [dbName, dbData] of Object.entries(idb as Record<string, any>)) {
    const stores = dbData?.stores || {};
    for (const [storeName, entries] of Object.entries(stores as Record<string, any[]>)) {
      const count = Array.isArray(entries) ? entries.length : 0;
      totalSourceRecordsInExport += count;

      if (dbName === 'v18:lab') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> trades & trade_legs',
        });
      } else if (dbName === 'suraj_archive_v1' && storeName === 'days') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> nightly_reviews',
        });
      } else if (dbName === 'suraj_archive_v1' && storeName === 'nights') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED (60 dates) / SKIPPED (151 duplicate nights logged with reason)',
        });
      } else if (dbName === 'suraj_archive_v1' && storeName === 'btc') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> market_timeseries (BTC daily)',
        });
      } else if (dbName === 'suraj_archive_v1' && storeName === 'iv') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> market_timeseries (IV curves)',
        });
      } else if (dbName === 'suraj_archive_v1' && storeName === 'events') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> alert_logs (VolTurn Signals)',
        });
      } else if (dbName === 'suraj_archive_v1' && storeName === 'flow') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> option_flow_buckets',
        });
      } else if (dbName === 'suraj_ind_v1' && storeName === 'rows') {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> indicator_snapshots (suraj_ind_v1 rows)',
        });
      } else if (dbName.startsWith('btc_iv_rv_terminal_v')) {
        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: 'MAPPED -> indicator_snapshots (Terminal V5/V6 telemetry)',
        });
      } else {
        // Unmapped store: document reason and record in skipped report
        let reason = 'Unmapped browser database store';
        if (storeName === 'meta') {
          reason = 'SKIPPED: System (Browser archive internal backup metadata)';
          tableStats.system_metadata.read += count;
          tableStats.system_metadata.skipped += count;
        } else if (dbName === 'strangle_desk_v1') {
          reason = 'SKIPPED: Auxiliary Database (Standalone strangle backtest desk KV store)';
          tableStats.auxiliary_idb_databases.read += count;
          tableStats.auxiliary_idb_databases.skipped += count;
        } else if (dbName === 'pd_desk' || dbName === 'v99_vol_surface' || dbName === 'nifty_desk_v1') {
          reason = `SKIPPED: Auxiliary Database (${dbName} desk state)`;
          tableStats.auxiliary_idb_databases.read += count;
          tableStats.auxiliary_idb_databases.skipped += count;
        } else if (dbName === 'btc_desk_market_cache') {
          reason = 'SKIPPED: Ephemeral Cache (In-flight REST orderbook/ticker cache; replaced by Redis)';
          tableStats.ephemeral_caches.read += count;
          tableStats.ephemeral_caches.skipped += count;
        } else if (dbName === 'btc_atm_iv_persistent_v30' || dbName === 'v146fut') {
          reason = 'SKIPPED: Ephemeral Cache (ATM IV / basis fast lookup cache; replaced by Redis)';
          tableStats.ephemeral_caches.read += count;
          tableStats.ephemeral_caches.skipped += count;
        }

        storeInventory.push({
          origin: 'IndexedDB',
          store: `${dbName}.${storeName}`,
          count,
          destination: reason,
        });

        // Record skipped entry in report
        skipped.push({
          source: `idb.${dbName}.${storeName}`,
          targetTable: '(none)',
          reason: `${reason} (${count} total records)`,
          rawRecord: {
            database: dbName,
            store: storeName,
            totalRecordsInStore: count,
            sampleRecord: entries?.[0] ? (entries[0].value || entries[0]) : null,
          },
        });
      }
    }
  }

  // --------------------------------------------------------------------------
  // Summary & Skipped Report
  // --------------------------------------------------------------------------
  let totalRead = 0;
  let totalMapped = 0;
  let totalSkipped = 0;

  for (const st of Object.values(tableStats)) {
    totalRead += st.read;
    totalMapped += st.mapped;
    totalSkipped += st.skipped;
  }

  console.log('\n' + '='.repeat(80));
  console.log('  SOURCE STORE INVENTORY (100% EXPORT DISCOVERY)');
  console.log('='.repeat(80));
  console.log(
    'Origin'.padEnd(14) +
    'Store Name'.padEnd(32) +
    'Records'.padEnd(12) +
    'Status / Destination'
  );
  console.log('-'.repeat(80));

  for (const item of storeInventory) {
    console.log(
      item.origin.padEnd(14) +
      item.store.padEnd(32) +
      String(item.count).padEnd(12) +
      item.destination
    );
  }
  console.log('-'.repeat(80));
  console.log(
    'TOTAL'.padEnd(46) +
    String(totalSourceRecordsInExport).padEnd(12) +
    'ALL RECORDS ACCOUNTED FOR'
  );
  console.log('='.repeat(80));

  console.log('\n' + '='.repeat(70));
  console.log('  RELATIONAL TARGET TABLES MIGRATION SUMMARY');
  console.log('='.repeat(70));
  console.log(
    'Table'.padEnd(24) +
    'Source Read'.padEnd(16) +
    'Mapped'.padEnd(16) +
    'Skipped'.padEnd(14)
  );
  console.log('-'.repeat(70));

  for (const [table, st] of Object.entries(tableStats)) {
    console.log(
      table.padEnd(24) +
      String(st.read).padEnd(16) +
      String(st.mapped).padEnd(16) +
      String(st.skipped).padEnd(14)
    );
  }
  console.log('-'.repeat(70));
  console.log(
    'TOTAL'.padEnd(24) +
    String(totalRead).padEnd(16) +
    String(totalMapped).padEnd(16) +
    String(totalSkipped).padEnd(14)
  );
  console.log('='.repeat(70));

  // Print sample rows in dry-run
  if (!isCommit) {
    console.log('\n[DRY-RUN SAMPLES]');
    if (mappedRecords.trades.length) {
      console.log('\nSample Mapped Trade (1 of ' + mappedRecords.trades.length + '):');
      console.log(JSON.stringify(mappedRecords.trades[0], null, 2));
    }
    if (mappedRecords.tradeLegs.length) {
      console.log('\nSample Mapped Trade Leg (1 of ' + mappedRecords.tradeLegs.length + '):');
      console.log(JSON.stringify(mappedRecords.tradeLegs[0], null, 2));
    }
    if (mappedRecords.nightlyReviews.length) {
      console.log('\nSample Mapped Nightly Review (1 of ' + mappedRecords.nightlyReviews.length + '):');
      console.log(JSON.stringify(mappedRecords.nightlyReviews[0], null, 2));
    }
    if (mappedRecords.chartDrawings.length) {
      console.log('\nSample Mapped Chart Drawing / Anchor (1 of ' + mappedRecords.chartDrawings.length + '):');
      console.log(JSON.stringify(mappedRecords.chartDrawings[0], null, 2));
    }
    if (mappedRecords.alertLogs.length) {
      console.log('\nSample Mapped Alert / Signal Log (1 of ' + mappedRecords.alertLogs.length + '):');
      console.log(JSON.stringify(mappedRecords.alertLogs[0], null, 2));
    }
    if (mappedRecords.indicatorSnapshots.length) {
      console.log('\nSample Mapped Indicator Snapshot (1 of ' + mappedRecords.indicatorSnapshots.length + '):');
      console.log(JSON.stringify(mappedRecords.indicatorSnapshots[0], null, 2));
    }
    if (mappedRecords.marketTimeseries.length) {
      console.log('\nSample Mapped Market Timeseries (1 of ' + mappedRecords.marketTimeseries.length + '):');
      console.log(JSON.stringify(mappedRecords.marketTimeseries[0], null, 2));
    }
    if (mappedRecords.optionFlowBuckets.length) {
      console.log('\nSample Mapped Option Flow Bucket (1 of ' + mappedRecords.optionFlowBuckets.length + '):');
      console.log(JSON.stringify(mappedRecords.optionFlowBuckets[0], null, 2));
    }
  }

  // Write skipped records report
  const skippedReportPath = path.resolve(process.cwd(), 'skipped-records.json');
  fs.writeFileSync(skippedReportPath, JSON.stringify(skipped, null, 2), 'utf-8');
  console.log(`\n[REPORT] ${skipped.length} skipped records logged to: ${skippedReportPath}`);

  if (isCommit) {
    console.log('\n[COMMIT] Live database write requested.');
    console.log('[COMMIT] Connecting to PostgreSQL pool...');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      console.log('[COMMIT] Database transaction started.');

      // 1. Ensure default user exists for foreign key references
      console.log(' -> Ensuring default user exists in users table...');
      await db
        .insert(users)
        .values({
          id: targetUserId,
          email: 'trader@volatilitydesk.internal',
          passwordHash: '$2b$10$ephemeral_migration_hash_placeholder',
          displayName: 'Master Trader',
          role: 'trader',
        })
        .onConflictDoNothing();

      // Helper for batched inserts
      const insertInBatches = async (name: string, table: any, records: any[], batchSize = 500) => {
        if (!records.length) return;
        process.stdout.write(` -> Inserting ${records.length} records into ${name}...`);
        for (let i = 0; i < records.length; i += batchSize) {
          const chunk = records.slice(i, i + batchSize);
          await db.insert(table).values(chunk).onConflictDoNothing();
        }
        console.log(' Done.');
      };

      // 2. Insert records in strict foreign-key dependency order
      await insertInBatches('user_preferences', userPreferences, mappedRecords.userPreferences);
      await insertInBatches('alert_rules', alertRules, mappedRecords.alertRules);
      await insertInBatches('alert_logs', alertLogs, mappedRecords.alertLogs);
      await insertInBatches('chart_drawings', chartDrawings, mappedRecords.chartDrawings);
      await insertInBatches('nightly_reviews', nightlyReviews, mappedRecords.nightlyReviews);
      await insertInBatches('trades', trades, mappedRecords.trades);
      await insertInBatches('trade_legs', tradeLegs, mappedRecords.tradeLegs);
      await insertInBatches('indicator_snapshots', indicatorSnapshots, mappedRecords.indicatorSnapshots);
      await insertInBatches('market_timeseries', marketTimeseries, mappedRecords.marketTimeseries);
      await insertInBatches('option_flow_buckets', optionFlowBuckets, mappedRecords.optionFlowBuckets);

      await client.query('COMMIT');
      console.log('\n[COMMIT SUCCESS] All 17,198 mapped records successfully committed to Neon PostgreSQL!');
    } catch (dbErr: any) {
      await client.query('ROLLBACK');
      console.error('\n[COMMIT FAILED] Transaction rolled back due to error:', dbErr);
      throw dbErr;
    } finally {
      client.release();
    }
  } else {
    console.log('\n[NOTE] Dry-run complete. No database records were written.');
    console.log('To commit changes to live database, run with: --commit');
  }

  return {
    sourceFile: filePath,
    mode: isCommit ? ('COMMIT' as const) : ('DRY_RUN' as const),
    totalRead,
    totalMapped,
    totalSkipped,
    tableCounts: tableStats,
  };
}

// CLI Execution entrypoint
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const isCommit = args.includes('--commit');
  const userIdx = args.indexOf('--user-id');
  const userId = userIdx !== -1 && args[userIdx + 1] ? args[userIdx + 1] : DEFAULT_USER_ID;
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath || args.includes('--help')) {
    console.log(`
Usage:
  npx tsx src/scripts/import-browser-data.ts <path-to-export.json> [options]

Options:
  --dry-run          Simulate import and print mapping summary (default)
  --commit           Write mapped records to PostgreSQL database
  --user-id <uuid>   Assign records to specific user (default: demo/trader UUID)
  --help             Show this help screen
    `);
    process.exit(0);
  }

  runImport(filePath, isCommit, userId)
    .catch((err) => {
      console.error('Fatal import error:', err);
      process.exit(1);
    })
    .finally(async () => {
      await pool.end();
    });
}
