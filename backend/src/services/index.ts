import { binanceWorker } from './binance-market-worker.js';
import { deribitWorker } from './deribit-flow-worker.js';
import { deltaWorker } from './delta-market-worker.js';
import { recalibrationScheduler } from './recalibration-scheduler.js';
import { macroStressWorker } from './macro-stress-worker.js';
import { botEngine } from './bot/bot-engine.js';
import { pulseEngine } from './pulse/pulse-engine.js';
import { hourlyBars } from './pulse/hourly-bars.js';
import { paperTerminal } from './paper/paper-terminal.js';
import { watchService } from './watch/sources.js';
import { algoEngine, seriesSampler } from './algo/algo-runtime.js';
import { paperMarks } from './paper/paper-marks.js';
import { fillsSync } from './fills-sync.js';
import { newsWatcher } from './news/index.js';
import { RULEBOOK_CONFIG } from '../lib/rulebook/config.js';
import { volWatch } from './vol/vol-watch.js';

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
    void botEngine.start(); // paper trading bot; no-op unless BOT_ENABLED=true
    void pulseEngine.start(); // Strangle Pulse collector; no-op unless PULSE_ENABLED=true
    if (process.env.PULSE_ENABLED === 'true') hourlyBars.start(); // public Binance hourly bars for the read-only regime gate
    paperTerminal.start(); // the user's own paper account: working orders, stops, expiry (idle when nothing is open)
    watchService.start(); // the stop alarm: watches every open position (bot, paper strategies, real Delta) for its stop
    paperMarks.start(); // one PnL sample a minute for every open Paper strategy (the minute graph)
    fillsSync.start(); // copies each account's Delta fills to the server for P&L and reconciliation (read-only)
    seriesSampler.start(); // ATM IV / DVOL history for the falling and IV-vs-clock conditions
    if (process.env.NEWS_ENABLED !== 'false') void newsWatcher.start(); // 24/7 shock alerts: news feeds + unexplained BTC moves → popup + Telegram (never trades)
    if (RULEBOOK_CONFIG.algoBlock) {
      // Rule Book: a red before-entry checklist holds the algo's entry (off unless algoBlock is set in the rule book config)
      algoEngine.ruleGate = async (uid) => {
        const { liveChecklist } = await import('./rulebook/rulebook-service.js');
        const c = await liveChecklist(uid);
        return { block: c.verdict !== 'GO', why: c.red.map((x) => ` (${x.now})`).join('; ') };
      };
    }
    if (process.env.NEWS_ENABLED !== 'false') volWatch.start(); // IV regime / compression change alerts and the open-trade compression tripwire (never trades)
    algoEngine.start(); // the Algo panel: waits for each armed strategy's window and conditions, enters once, manages the exit
  }

  stopAll() {
    this.isStarted = false;
    console.log('[WorkerManager] Shutting down background workers...');
    binanceWorker.stop();
    deribitWorker.stop();
    deltaWorker.stop();
    recalibrationScheduler.stop();
    macroStressWorker.stop();
    botEngine.stop();
    pulseEngine.stop();
    hourlyBars.stop();
    paperTerminal.stop();
    watchService.stop();
    algoEngine.stop();
    seriesSampler.stop();
    paperMarks.stop();
    fillsSync.stop();
    newsWatcher.stop();
    volWatch.stop();
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
