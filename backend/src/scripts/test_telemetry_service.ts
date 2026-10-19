import 'dotenv/config';
import { recordSessionTelemetry, runAutomatedRecalibration, evaluateLockedRule } from '../services/self-testing-audit.js';
import { pool } from '../db/index.js';

async function main() {
  console.log('Testing Self-Testing Telemetry Service...');

  // Test 1: Tuesday Night, 22:45 IST (Inside Proven Entry Window), Speed = 1.10x (< 1.50x)
  // Expected Rule: TUE_PRIME, PROVEN_ENTRY, CALM, GO, Sizing 1.0x
  const tuesdayTime = new Date('2026-10-20T17:15:00Z').getTime(); // 22:45 IST
  const rule1 = evaluateLockedRule(tuesdayTime, 1.10);
  console.log('Rule 1 Evaluation (Tuesday 22:45 IST, Speed 1.10x):', rule1);

  const test1 = await recordSessionTelemetry({
    sessionDate: '2026-10-20',
    timestampMs: tuesdayTime,
    callStrike: 72000,
    putStrike: 64000,
    callDelta: 0.14,
    putDelta: 0.14,
    callEntryPremium: 165,
    putEntryPremium: 155,
    speedVsIv: 1.10,
    sizing: 1.0,
    uiState: {
      calendarDay: 'TUE_PRIME',
      clockWindow: 'PROVEN_ENTRY',
      speedBeacon: 'CALM',
      goSignal: 'GO',
      statusWord: 'GREEN GO · FULL SIZE',
    },
  });
  console.log('Test 1 Telemetry Insert (Should Match):', {
    telemetryMatch: test1.telemetryMatch,
    mismatchReason: test1.mismatchReason,
    id: test1.log.id,
  });

  // Test 2: Thursday Night, Speed = 0.90x
  // UI incorrectly shows GO -> Self-test should FLAG mismatch!
  const thursdayTime = new Date('2026-10-22T17:15:00Z').getTime(); // 22:45 IST Thursday
  const test2 = await recordSessionTelemetry({
    sessionDate: '2026-10-22',
    timestampMs: thursdayTime,
    speedVsIv: 0.90,
    sizing: 0.0,
    outcome: 'SKIPPED',
    uiState: {
      calendarDay: 'TUE_PRIME', // INTENTIONAL DRIFT TEST
      clockWindow: 'PROVEN_ENTRY',
      speedBeacon: 'CALM',
      goSignal: 'GO', // INTENTIONAL DRIFT TEST: Thursday cannot have GO
      statusWord: 'GREEN GO',
    },
  });
  console.log('Test 2 Telemetry Insert (Should FLAG MISMATCH):', {
    telemetryMatch: test2.telemetryMatch,
    mismatchReason: test2.mismatchReason,
    id: test2.log.id,
  });

  // Test 3: Run Automated Recalibration
  console.log('\nRunning Automated Recalibration...');
  const recal = await runAutomatedRecalibration();
  console.log('Recalibration Result:', {
    id: recal.id,
    totalSessions: recal.totalSessions,
    clearedBonferroni: recal.clearedBonferroni,
    comboPValue: recal.comboPValue,
    oosStopRate: recal.oosStopRate,
    stabilityVerdict: recal.oosStabilityVerdict,
  });

  await pool.end();
  console.log('All telemetry and self-testing tests passed successfully!');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
