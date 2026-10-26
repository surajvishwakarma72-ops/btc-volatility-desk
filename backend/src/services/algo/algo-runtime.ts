import { fetchCandles, fetchChain, type ChainSnapshot } from '../bot/delta-public.js';
import { evaluateGate } from '../bot/gate.js';
import type { Bar } from '../../lib/bot/futures.js';
import { deribitWorker } from '../deribit-flow-worker.js';
import { AlgoEngine, type AlgoDeps, type MarketData } from './algo-engine.js';
import { createRun, finishRun, getRun, listArmed, openRuns, recordMark } from './algo-store.js';
import { paperBroker } from './brokers.js';
import { liveBroker, refreshTicks } from './live-entry.js';

/** The real market inputs for the Algo engine, cached so a dozen strategies cost one Delta fetch per few seconds. */
let chain: { at: number; v: ChainSnapshot } | null = null;
let bars: { at: number; v: Bar[] } | null = null;

export async function loadMarket(needBars: boolean): Promise<MarketData> {
  const now = Date.now();
  if (!chain || now - chain.at > 4_000) {
    chain = { at: now, v: await fetchChain(now) };
    void refreshTicks().catch(() => undefined);
  }
  if (needBars && (!bars || now - bars.at > 60_000)) {
    bars = { at: now, v: await fetchCandles('BTCUSD', '5m', Math.floor(now / 1000) - 3 * 86_400, Math.floor(now / 1000)) };
  }
  const g = evaluateGate();
  return {
    spot: chain.v.spot, chain: chain.v.options, expiries: chain.v.expiries,
    dvol: deribitWorker.currentDvol ?? null, gateGo: g.go, gateReasons: g.reasons,
    // the last bar is still forming: indicators use closed bars only
    bars5m: needBars && bars ? bars.v.slice(0, -1) : [],
  };
}

export const realAlgoDeps: AlgoDeps = {
  now: Date.now,
  armed: listArmed,
  openRuns,
  getRun,
  createRun,
  finishRun,
  mark: recordMark,
  market: loadMarket,
  broker: (mode) => (mode === 'live' ? liveBroker : paperBroker),
};

export const algoEngine = new AlgoEngine(realAlgoDeps);
