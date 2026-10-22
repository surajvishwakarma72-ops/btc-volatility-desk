import { binanceWorker } from './binance-market-worker.js';
import { deribitWorker } from './deribit-flow-worker.js';
import { deltaWorker } from './delta-market-worker.js';
import { recalibrationScheduler } from './recalibration-scheduler.js';
import { macroStressWorker } from './macro-stress-worker.js';

export { alertService } from './alert-service.js';
export { binanceWorker } from './binance-market-worker.js';
export { deribitWorker } from './deribit-flow-worker.js';
export { deltaWorker } from './delta-market-worker.js';
export { recalibrationScheduler } from './recalibration-scheduler.js';
export { macroStressWorker } from './macro-stress-worker.js';

/**
 * Background Ingestion & Alert Workers Lifecycle Manager
 */
export class WorkerManager {
  private isStarted = false;

  startAll() {
    if (this.isStarted) return;
    this.isStarted = true;

    console.log('[WorkerManager] Bootstrapping 24/7 market ingestion and alert workers...');
    binanceWorker.start();
    deribitWorker.start(60_000); // Poll Deribit flow every 60s
    deltaWorker.start();
    recalibrationScheduler.start(); // Daily Bonferroni & 50/50 OOS re-validation
    macroStressWorker.start(); // 5-minute outside market pressure recording
  }

  stopAll() {
    this.isStarted = false;
    console.log('[WorkerManager] Shutting down background workers...');
    binanceWorker.stop();
    deribitWorker.stop();
    deltaWorker.stop();
    recalibrationScheduler.stop();
    macroStressWorker.stop();
  }

  getStatus() {
    const spot = binanceWorker.currentSpotPrice || deltaWorker.currentSpotPrice || null;
    return {
      binance: {
        status: binanceWorker.status,
        lastKlineTime: binanceWorker.lastKlineTime,
        spotPrice: binanceWorker.currentSpotPrice,
      },
      deribit: {
        status: deribitWorker.status,
        currentDvol: deribitWorker.currentDvol,
        lastPollTime: deribitWorker.lastPollTime,
      },
      deltaIndia: {
        status: deltaWorker.status,
        markPrice: deltaWorker.currentMarkPrice,
        spotPrice: deltaWorker.currentSpotPrice,
        openInterest: deltaWorker.currentOi,
        lastTickTime: deltaWorker.lastTickTime,
      },
      macroStress: {
        score: macroStressWorker.getSnapshot().score,
        zone: macroStressWorker.getSnapshot().zone,
        direction: macroStressWorker.getSnapshot().direction,
        status: macroStressWorker.getSnapshot().status,
      },
      aggregated: {
        spotPrice: spot,
        dvol: deribitWorker.currentDvol,
      },
    };
  }
}

export const workerManager = new WorkerManager();
