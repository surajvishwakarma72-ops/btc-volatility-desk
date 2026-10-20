import { db, sessionAuditLogs, recalibrationAudits } from '../db/index.js';
import { computeRecalibration, type SessionRec } from '../lib/recalibration.js';

export const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000001';

// Shared Locked Production Boundaries (IST)
export const PROVEN_BOUNDARIES = {
  ENTRY_START_MINS: 1350, // 22:30 IST (NY+180m point estimate, p = 0.0014)
  ENTRY_END_MINS: 1410,   // 23:30 IST
  SETUP_START_MINS: 1290, // 21:30 IST (Amber setup watch)
  SETUP_END_MINS: 1350,   // 22:30 IST
  EXIT_START_MINS: 240,   // 04:00 IST (Morning exit)
  EXIT_END_MINS: 420,     // 07:00 IST
  TRAP_MINS_START: 1020,  // 17:00 IST (Prohibited settlement trap)
  TRAP_MINS_END: 1080,    // 18:00 IST
  SPEED_LIMIT: 1.50,      // Kinetic storm limit
};

export interface UIStatePayload {
  calendarDay: string;   // 'TUE_PRIME' | 'WED_PRIME' | 'MON_HALF' | 'FRI_HALF' | 'THU_SKIP' | 'WEEKEND_OFF'
  clockWindow: string;   // 'PROVEN_ENTRY' | 'SETUP_WATCH' | 'MORNING_EXIT' | 'SETTLEMENT_TRAP' | 'CLOSED' | 'MONITORING'
  speedBeacon: string;   // 'CALM' | 'STORM'
  goSignal: string;      // 'GO' | 'NOT_NOW'
  statusWord: string;
}

export interface SessionTelemetryInput {
  userId?: string;
  sessionDate: string;   // 'YYYY-MM-DD'
  timestampMs?: number;
  entryTime?: string;
  exitTime?: string;
  callStrike?: number;
  putStrike?: number;
  callDelta?: number;
  putDelta?: number;
  callEntryPremium?: number;
  putEntryPremium?: number;
  callExitPremium?: number;
  putExitPremium?: number;
  speedVsIv: number;
  sizing?: number;
  realizedPnl?: number;
  outcome?: 'WIN' | 'STOP' | 'SKIPPED' | 'SCRATCH';
  sessionStatus?: 'TRADED' | 'SKIPPED';
  uiState: UIStatePayload;
  meta?: any;
}

/**
 * Pure evaluation of the locked strategy rule against any point in time & speed.
 */
export function evaluateLockedRule(timeMs: number, speedVal: number) {
  const istDate = new Date(timeMs + 19800000); // UTC + 5.5 hours
  const dow = istDate.getUTCDay(); // 0 = Sun, 1 = Mon, 2 = Tue, 3 = Wed, 4 = Thu, 5 = Fri, 6 = Sat
  const istMins = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();

  // Calendar Rule
  let expectedCalendar = 'WEEKEND_OFF';
  let expectedSizing = 0.0;
  let calendarOk = false;
  if (dow === 2 || dow === 3) {
    expectedCalendar = dow === 2 ? 'TUE_PRIME' : 'WED_PRIME';
    expectedSizing = 1.0;
    calendarOk = true;
  } else if (dow === 1 || dow === 5) {
    expectedCalendar = dow === 1 ? 'MON_HALF' : 'FRI_HALF';
    expectedSizing = 0.5;
    calendarOk = true;
  } else if (dow === 4) {
    expectedCalendar = 'THU_SKIP';
    expectedSizing = 0.0;
    calendarOk = false;
  }

  // Speed Beacon Rule
  const expectedSpeed = speedVal < PROVEN_BOUNDARIES.SPEED_LIMIT ? 'CALM' : 'STORM';
  const speedOk = speedVal < PROVEN_BOUNDARIES.SPEED_LIMIT;

  // Clock Window Rule
  let expectedWindow = 'MONITORING';
  let inProvenEntryWindow = false;
  if (istMins >= PROVEN_BOUNDARIES.ENTRY_START_MINS && istMins <= PROVEN_BOUNDARIES.ENTRY_END_MINS) {
    expectedWindow = 'PROVEN_ENTRY';
    inProvenEntryWindow = true;
  } else if (istMins >= PROVEN_BOUNDARIES.SETUP_START_MINS && istMins < PROVEN_BOUNDARIES.SETUP_END_MINS) {
    expectedWindow = 'SETUP_WATCH';
  } else if (istMins >= PROVEN_BOUNDARIES.EXIT_START_MINS && istMins <= PROVEN_BOUNDARIES.EXIT_END_MINS) {
    expectedWindow = 'MORNING_EXIT';
  } else if (istMins >= PROVEN_BOUNDARIES.TRAP_MINS_START && istMins <= PROVEN_BOUNDARIES.TRAP_MINS_END) {
    expectedWindow = 'SETTLEMENT_TRAP';
  } else if (istMins > PROVEN_BOUNDARIES.ENTRY_END_MINS || istMins < PROVEN_BOUNDARIES.EXIT_START_MINS) {
    expectedWindow = 'CLOSED';
  }

  // Combined GO Rule: ALL THREE MUST AGREE SIMULTANEOUSLY
  const expectedGo = (calendarOk && speedOk && inProvenEntryWindow) ? 'GO' : 'NOT_NOW';

  return {
    dow,
    istMins,
    expectedCalendar,
    expectedSpeed,
    expectedWindow,
    expectedGo,
    expectedSizing,
  };
}

/**
 * Record session telemetry and immediately execute self-testing validation.
 */
export async function recordSessionTelemetry(input: SessionTelemetryInput) {
  const userId = input.userId || DEFAULT_USER_ID;
  const timeMs = input.timestampMs || (input.entryTime ? new Date(input.entryTime).getTime() : Date.now());
  const rule = evaluateLockedRule(timeMs, input.speedVsIv);

  // Self-testing verification: compare UI state vs Rule state
  let telemetryMatch = true;
  const mismatchReasons: string[] = [];

  const uiGo = input.uiState.goSignal?.toUpperCase() === 'GO' ? 'GO' : 'NOT_NOW';
  if (uiGo !== rule.expectedGo) {
    telemetryMatch = false;
    mismatchReasons.push(`GO signal mismatch: UI displayed "${uiGo}" but Rule dictates "${rule.expectedGo}"`);
  }

  const uiSpeed = input.uiState.speedBeacon?.toUpperCase();
  if (uiSpeed && uiSpeed !== rule.expectedSpeed) {
    telemetryMatch = false;
    mismatchReasons.push(`Speed gate mismatch: UI displayed "${uiSpeed}" but Rule dictates "${rule.expectedSpeed}" (Speed=${input.speedVsIv.toFixed(2)}x)`);
  }

  if (input.uiState.calendarDay && input.uiState.calendarDay !== rule.expectedCalendar) {
    telemetryMatch = false;
    mismatchReasons.push(`Calendar day mismatch: UI displayed "${input.uiState.calendarDay}" but Rule dictates "${rule.expectedCalendar}"`);
  }

  const mismatchReason = mismatchReasons.length ? mismatchReasons.join(' | ') : null;

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = dayNames[rule.dow];

  const ruleState = {
    expectedCalendar: rule.expectedCalendar,
    expectedWindow: rule.expectedWindow,
    expectedSpeed: rule.expectedSpeed,
    expectedGo: rule.expectedGo,
    expectedSizing: rule.expectedSizing,
  };

  const inserted = await db.insert(sessionAuditLogs).values({
    userId,
    sessionDate: input.sessionDate,
    dayOfWeek: rule.dow,
    dayName,
    sessionStatus: input.sessionStatus || (rule.expectedGo === 'GO' ? 'TRADED' : 'SKIPPED'),
    entryTime: input.entryTime ? new Date(input.entryTime) : (rule.expectedGo === 'GO' ? new Date(timeMs) : null),
    exitTime: input.exitTime ? new Date(input.exitTime) : null,
    callStrike: input.callStrike ? String(input.callStrike) : null,
    putStrike: input.putStrike ? String(input.putStrike) : null,
    callDelta: input.callDelta ? String(input.callDelta) : null,
    putDelta: input.putDelta ? String(input.putDelta) : null,
    callEntryPremium: input.callEntryPremium ? String(input.callEntryPremium) : null,
    putEntryPremium: input.putEntryPremium ? String(input.putEntryPremium) : null,
    callExitPremium: input.callExitPremium ? String(input.callExitPremium) : null,
    putExitPremium: input.putExitPremium ? String(input.putExitPremium) : null,
    speedVsIv: String(input.speedVsIv),
    sizing: String(input.sizing != null ? input.sizing : rule.expectedSizing),
    realizedPnl: input.realizedPnl != null ? String(input.realizedPnl) : null,
    outcome: input.outcome || (rule.expectedGo === 'GO' ? 'PENDING' : 'SKIPPED'),
    uiState: input.uiState,
    ruleState,
    telemetryMatch,
    mismatchReason,
    meta: input.meta || {},
  }).returning();

  return {
    success: true,
    telemetryMatch,
    mismatchReason,
    log: inserted[0],
  };
}

/**
 * On-demand or scheduled recalibration:
 * Re-runs Bonferroni correction and 50/50 walk-forward OOS validation against the database.
 */
export async function runAutomatedRecalibration() {
  const logs = await db.select().from(sessionAuditLogs).orderBy(sessionAuditLogs.sessionDate);

  const sessions: SessionRec[] = logs.map((l) => ({
    date: l.sessionDate,
    dow: l.dayOfWeek,
    speed: Number(l.speedVsIv) || 1.0,
    isStop: l.outcome === 'STOP',
    sizing: Number(l.sizing) || 0,
    status: l.sessionStatus,
  }));

  const result = computeRecalibration(sessions, {
    minSample: 30,
    bonferroniAlpha: 0.001515,
    seeded: {
      tueWedStopRate: 38.0,
      speedStopRate: 44.3,
      comboStopRate: 32.6,
      comboPValue: 0.0012,
      oosStopRate: 28.4,
    },
  });

  const auditSummary = {
    source: result.source,
    newSessionsLogged: logs.length,
    telemetryMatches: logs.filter((l) => l.telemetryMatch).length,
    telemetryMismatches: logs.filter((l) => !l.telemetryMatch).length,
    decayFlag: result.oosStabilityVerdict === 'DECAYING',
    timestamp: new Date().toISOString(),
  };

  const auditRecord = await db.insert(recalibrationAudits).values({
    totalSessions: result.totalSessions,
    inSampleSessions: result.inSampleSessions,
    outOfSampleSessions: result.outOfSampleSessions,
    bonferroniAlpha: String(result.bonferroniAlpha),
    tueWedStopRate: String(result.tueWedStopRate),
    speedStopRate: String(result.speedStopRate),
    comboStopRate: String(result.comboStopRate),
    comboPValue: String(result.comboPValue),
    clearedBonferroni: result.clearedBonferroni,
    oosStopRate: String(result.oosStopRate),
    oosStabilityVerdict: result.oosStabilityVerdict,
    auditSummary,
  }).returning();

  return auditRecord[0];
}
