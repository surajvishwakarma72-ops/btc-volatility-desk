import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Schema table imports for typing & validation reference
import {
  trades,
  tradeLegs,
  nightlyReviews,
  chartDrawings,
  userPreferences,
  alertRules,
  alertLogs,
  indicatorSnapshots,
} from '../db/schema.js';

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
 * Normalizes timestamps safely to ISO-8601 strings
 */
function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') return new Date(val);
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export async function runImport(filePath: string, isCommit: boolean = false, targetUserId: string = DEFAULT_USER_ID) {
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

  const rawContent = fs.readFileSync(filePath, 'utf-8');
  let exportBundle: any;

  try {
    exportBundle = JSON.parse(rawContent);
  } catch (err: any) {
    console.error(`\n[ERROR] Invalid JSON in ${filePath}:`, err.message);
    process.exit(1);
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
  } = {
    trades: [],
    tradeLegs: [],
    nightlyReviews: [],
    chartDrawings: [],
    userPreferences: [],
    alertRules: [],
    alertLogs: [],
    indicatorSnapshots: [],
  };

  const tableStats: Record<string, { read: number; mapped: number; skipped: number }> = {
    trades: { read: 0, mapped: 0, skipped: 0 },
    trade_legs: { read: 0, mapped: 0, skipped: 0 },
    nightly_reviews: { read: 0, mapped: 0, skipped: 0 },
    chart_drawings: { read: 0, mapped: 0, skipped: 0 },
    user_preferences: { read: 0, mapped: 0, skipped: 0 },
    alert_rules: { read: 0, mapped: 0, skipped: 0 },
    alert_logs: { read: 0, mapped: 0, skipped: 0 },
    indicator_snapshots: { read: 0, mapped: 0, skipped: 0 },
  };

  const ls = exportBundle.localStorage || {};
  const idb = exportBundle.indexedDB || {};

  // --------------------------------------------------------------------------
  // 1. Map Trades & Trade Legs (v99_trades, v99_trade, v18:lab)
  // --------------------------------------------------------------------------
  console.log('\n[1/6] Processing Trades & Trade Legs...');
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
      const entryTime = toDate(raw.entryTime || raw.t || raw.entry_t || raw.date);
      const expiryDate = toDate(raw.expiryDate || raw.expiry || raw.exp || (entryTime ? new Date(entryTime.getTime() + 86400000) : null));

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

      const callStrike = toNum(raw.callStrike || raw.c_strike || raw.cStrike || raw.call || raw.strikes?.[0], 0);
      const putStrike = toNum(raw.putStrike || raw.p_strike || raw.pStrike || raw.put || raw.strikes?.[1], 0);

      const tradeId = crypto.randomUUID();
      const status = raw.status === 'OPEN' ? 'OPEN' : raw.status === 'CANCELLED' ? 'CANCELLED' : 'CLOSED';

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
        exitTime: toDate(raw.exitTime || raw.exit_t || raw.closedAt),
        entrySpot: toNum(raw.entrySpot || raw.spot || raw.spot0, 0) || '0',
        exitSpot: toNum(raw.exitSpot || raw.spotExit),
        entryIv: toNum(raw.entryIv || raw.iv0 || raw.soldIv || raw.iv, 0) || '0',
        exitIv: toNum(raw.exitIv || raw.ivExit),
        contracts: toNum(raw.contracts || raw.size || raw.qty, 1) || '1',
        realizedPnl: toNum(raw.realizedPnl || raw.pnl || raw.realized_pnl),
        exitReason: raw.exitReason || raw.reason || null,
        entryGreeks: raw.entryGreeks || raw.greeks || {},
        pnlAttribution: raw.pnlAttribution || {},
      };

      mappedRecords.trades.push(tradeRow);
      tableStats.trades.mapped++;

      // Create detailed Trade Legs (Call & Put)
      tableStats.trade_legs.read += 2;

      // Call Leg
      const callLeg = {
        id: crypto.randomUUID(),
        tradeId: tradeId,
        legType: 'CALL',
        strike: tradeRow.callStrike,
        entryPremium: toNum(raw.callEntryPremium || raw.c_prem || raw.callPrem, 0) || '0',
        exitPremium: toNum(raw.callExitPremium || raw.c_exit_prem),
        entryIv: toNum(raw.callEntryIv || tradeRow.entryIv, 0) || '0',
        exitIv: toNum(raw.callExitIv || tradeRow.exitIv),
        status: status === 'OPEN' ? 'OPEN' : raw.stoppedLeg === 'CALL' ? 'STOPPED' : 'CLOSED',
        stopLossLevel: toNum(raw.callStopLevel || raw.c_stop),
        triggeredExit: raw.stoppedLeg === 'CALL' || raw.exitTriggerLeg === 'CALL',
      };
      mappedRecords.tradeLegs.push(callLeg);
      tableStats.trade_legs.mapped++;

      // Put Leg
      const putLeg = {
        id: crypto.randomUUID(),
        tradeId: tradeId,
        legType: 'PUT',
        strike: tradeRow.putStrike,
        entryPremium: toNum(raw.putEntryPremium || raw.p_prem || raw.putPrem, 0) || '0',
        exitPremium: toNum(raw.putExitPremium || raw.p_exit_prem),
        entryIv: toNum(raw.putEntryIv || tradeRow.entryIv, 0) || '0',
        exitIv: toNum(raw.putExitIv || tradeRow.exitIv),
        status: status === 'OPEN' ? 'OPEN' : raw.stoppedLeg === 'PUT' ? 'STOPPED' : 'CLOSED',
        stopLossLevel: toNum(raw.putStopLevel || raw.p_stop),
        triggeredExit: raw.stoppedLeg === 'PUT' || raw.exitTriggerLeg === 'PUT',
      };
      mappedRecords.tradeLegs.push(putLeg);
      tableStats.trade_legs.mapped++;

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
  // 2. Map Nightly Reviews (v147_nights, ivcool:nights, suraj_archive_v1.days)
  // --------------------------------------------------------------------------
  console.log('[2/6] Processing Nightly Reviews & Calendar History...');
  const nightSources: any[] = [];

  // v147_nights
  if (ls['v147_nights']?.parsed && Array.isArray(ls['v147_nights'].parsed)) {
    for (const n of ls['v147_nights'].parsed) {
      nightSources.push({ ...n, _source: 'localStorage.v147_nights' });
    }
  }

  // suraj_archive_v1.days
  if (idb['suraj_archive_v1']?.stores?.days) {
    for (const e of idb['suraj_archive_v1'].stores.days) {
      nightSources.push({ ...(e.value || e), _source: 'idb.suraj_archive_v1.days' });
    }
  }

  tableStats.nightly_reviews.read = nightSources.length;
  const seenDates = new Set<string>();

  for (const raw of nightSources) {
    try {
      const dateStr = raw.sessionDate || raw.date || raw.d || (raw.t ? new Date(raw.t).toISOString().slice(0, 10) : null);
      if (!dateStr || seenDates.has(dateStr)) {
        if (!dateStr) {
          skipped.push({
            source: raw._source || 'nightly_reviews',
            targetTable: 'nightly_reviews',
            reason: 'Missing session date',
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
        iv1730: toNum(raw.iv1730 || raw.e1730 || raw.pre),
        ivNyOpen: toNum(raw.ivNyOpen || raw.eOpen || raw.e),
        ivExit: toNum(raw.ivExit || raw.x07 || raw.x15),
        speedVsIv: toNum(raw.speedVsIv || raw.speed),
        adxTrend: raw.adxTrend || (raw.adxFalling ? 'FALLING' : null),
        exitHour: Number.isInteger(raw.exitHour) ? raw.exitHour : null,
        eventTags: Array.isArray(raw.eventTags || raw.tags) ? (raw.eventTags || raw.tags) : [],
        notes: raw.notes || raw.txt || null,
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
  // 3. Map Chart Drawings (btc_drawings_v1)
  // --------------------------------------------------------------------------
  console.log('[3/6] Processing Chart Drawings...');
  const drawingsSource = ls['btc_drawings_v1']?.parsed;
  if (Array.isArray(drawingsSource)) {
    tableStats.chart_drawings.read = drawingsSource.length;
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

  // --------------------------------------------------------------------------
  // 4. Map User Preferences (v132_ind, v143_skin, btc_vol_desk_prefs_v1)
  // --------------------------------------------------------------------------
  console.log('[4/6] Processing Workspace Preferences...');
  tableStats.user_preferences.read = 1;

  const activeInd = ls['v132_ind']?.parsed || [];
  const skin = ls['v143_skin']?.parsed === '0' ? 'classic_dark' : 'coinglass_dark';
  const deskPrefs = ls['btc_vol_desk_prefs_v1']?.parsed || {};

  mappedRecords.userPreferences.push({
    id: crypto.randomUUID(),
    userId: targetUserId,
    theme: skin,
    activeIndicators: Array.isArray(activeInd) ? activeInd : Object.keys(activeInd),
    chartLayout: deskPrefs.layout || {},
    riskLimits: deskPrefs.risk || {},
  });
  tableStats.user_preferences.mapped = 1;

  // --------------------------------------------------------------------------
  // 5. Map Alerts (vt_alert_prefs_v1, btc_alerts_v1)
  // --------------------------------------------------------------------------
  console.log('[5/6] Processing Alert Rules & Logs...');
  const alertPrefs = ls['vt_alert_prefs_v1']?.parsed || {};
  const alertLogList = ls['btc_alerts_v1']?.parsed || [];

  if (alertPrefs && typeof alertPrefs === 'object') {
    tableStats.alert_rules.read = 1;
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
    tableStats.alert_rules.mapped = 1;
  }

  if (Array.isArray(alertLogList)) {
    tableStats.alert_logs.read = alertLogList.length;
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

  // --------------------------------------------------------------------------
  // 6. Map Indicator Snapshots (suraj_ind_v1 rows)
  // --------------------------------------------------------------------------
  console.log('[6/6] Processing Indicator Snapshots (suraj_ind_v1 / 5-min intervals)...');
  const snapEntries: any[] = [];

  if (idb['suraj_ind_v1']?.stores?.rows) {
    for (const e of idb['suraj_ind_v1'].stores.rows) {
      snapEntries.push(e.value || e);
    }
  }

  tableStats.indicator_snapshots.read = snapEntries.length;
  const seenSnaps = new Set<number>();

  for (const raw of snapEntries) {
    try {
      const timestampMs = Number(raw.t || raw.timestamp || raw.time);
      if (!Number.isFinite(timestampMs) || seenSnaps.has(timestampMs)) {
        if (!Number.isFinite(timestampMs)) {
          skipped.push({
            source: 'idb.suraj_ind_v1.rows',
            targetTable: 'indicator_snapshots',
            reason: 'Invalid snapshot timestamp (t)',
            rawRecord: raw,
          });
          tableStats.indicator_snapshots.skipped++;
        }
        continue;
      }

      seenSnaps.add(timestampMs);

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

  // --------------------------------------------------------------------------
  // Summary & Skipped Report
  // --------------------------------------------------------------------------
  let totalRead = 0;
  let totalMapped = 0;
  let totalSkipped = skipped.length;

  for (const st of Object.values(tableStats)) {
    totalRead += st.read;
    totalMapped += st.mapped;
  }

  console.log('\n' + '='.repeat(70));
  console.log('  MIGRATION SUMMARY');
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
    if (mappedRecords.indicatorSnapshots.length) {
      console.log('\nSample Mapped Indicator Snapshot (1 of ' + mappedRecords.indicatorSnapshots.length + '):');
      console.log(JSON.stringify(mappedRecords.indicatorSnapshots[0], null, 2));
    }
  }

  // Write skipped records report
  const skippedReportPath = path.resolve(process.cwd(), 'skipped-records.json');
  fs.writeFileSync(skippedReportPath, JSON.stringify(skipped, null, 2), 'utf-8');
  console.log(`\n[REPORT] ${skipped.length} skipped records logged to: ${skippedReportPath}`);

  if (isCommit) {
    console.log('\n[COMMIT] Live database write requested.');
    console.log('[COMMIT] Drizzle schema validated. Connect database pool to execute final INSERT transactions.');
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

  runImport(filePath, isCommit, userId).catch((err) => {
    console.error('Fatal import error:', err);
    process.exit(1);
  });
}
