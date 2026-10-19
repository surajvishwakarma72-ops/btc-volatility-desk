import { runAutomatedRecalibration } from './self-testing-audit.js';

/**
 * Scheduled Recalibration Worker
 * 
 * Periodically re-tests the growing database of recorded trading sessions
 * against the Bonferroni correction threshold (alpha = 0.001515) and 
 * runs 50/50 chronological walk-forward out-of-sample validation to 
 * detect any alpha decay or statistical instability.
 */
export class RecalibrationScheduler {
  private timer: NodeJS.Timeout | null = null;
  private intervalMs = 24 * 60 * 60 * 1000; // Daily re-validation (24 hours)
  public lastRunTime: Date | null = null;
  public lastResult: any = null;

  start(customIntervalMs?: number) {
    if (this.timer) return;
    if (customIntervalMs) this.intervalMs = customIntervalMs;

    console.log('[RecalibrationScheduler] Starting automated Bonferroni & 50/50 OOS re-validation worker...');
    
    // Execute initial audit run after 5 seconds on boot
    setTimeout(() => {
      this.executeAudit();
    }, 5000);

    // Schedule recurring periodic audit
    this.timer = setInterval(() => {
      this.executeAudit();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[RecalibrationScheduler] Stopped automated re-validation worker.');
    }
  }

  async executeAudit() {
    try {
      console.log('[RecalibrationScheduler] Executing scheduled Bonferroni & 50/50 OOS re-validation...');
      const result = await runAutomatedRecalibration();
      this.lastRunTime = new Date();
      this.lastResult = result;
      console.log(`[RecalibrationScheduler] Re-validation complete. Total sessions: ${result.totalSessions}, OOS Stop Rate: ${result.oosStopRate}%, Verdict: ${result.oosStabilityVerdict}`);
      return result;
    } catch (err) {
      console.error('[RecalibrationScheduler] Error during scheduled recalibration:', err);
      return null;
    }
  }
}

export const recalibrationScheduler = new RecalibrationScheduler();
