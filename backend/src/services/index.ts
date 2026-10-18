import { alertService } from './alert-service.js';
import { binanceWorker } from './binance-market-worker.js';
import { deribitWorker } from './deribit-flow-worker.js';
import { deltaWorker } from './delta-market-worker.js';

export { alertService } from './alert-service.js';
export { binanceWorker } from './binance-market-worker.js';
export { deribitWorker } from './deribit-flow-worker.js';
export { deltaWorker } from './delta-market-worker.js';

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
  }

  stopAll() {
    this.isStarted = false;
    console.log('[WorkerManager] Shutting down background workers...');
    binanceWorker.stop();
    deribitWorker.stop();
    deltaWorker.stop();
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
      aggregated: {
        spotPrice: spot,
        dvol: deribitWorker.currentDvol,
      },
    };
  }
}

export const workerManager = new WorkerManager();
