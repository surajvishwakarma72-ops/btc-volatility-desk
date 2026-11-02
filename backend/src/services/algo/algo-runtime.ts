import { fetchCandles, fetchChain, type ChainSnapshot } from '../bot/delta-public.js';
import { evaluateGate } from '../bot/gate.js';
import type { Bar } from '../../lib/bot/futures.js';
import { deribitWorker } from '../deribit-flow-worker.js';
import { AlgoEngine, type AlgoDeps, type MarketData } from './algo-engine.js';
import { createRun, finishRun, getRun, listArmed, openRuns, recordMark, setArmed } from './algo-store.js';
import { clockIv, type Sample } from '../../lib/algo/series-math.js';
import { backfillDvol, loadSeries, recordSample } from './series.js';
import { atmIvOf } from './algo-engine.js';
import { defaultStrangle } from '../../lib/algo/rule.js';
import { pulseNow } from '../pulse/pulse-score.js';
import type { Slot } from '../../lib/pulse/grid.js';
import { paperBroker } from './brokers.js';
import { liveBroker, refreshTicks } from './live-entry.js';

/** The real market inputs for the Algo engine, cached so a dozen strategies cost one Delta fetch per few seconds. */
let chain: { at: number; v: ChainSnapshot } | null = null;
let bars: { at: number; v: Bar[] } | null = null;
let hist: { at: number; hist: Sample[]; clock: ReturnType<typeof clockIv> } | null = null;

export async function loadMarket(needBars: boolean, needHist = false, pulseSlot?: Slot): Promise<MarketData> {
  const now = Date.now();
  if (!chain || now - chain.at > 4_000) {
    chain = { at: now, v: await fetchChain(now) };
    void refreshTicks().catch(() => undefined);
  }
  if (needBars && (!bars || now - bars.at > 60_000)) {
    // six days of 5 minute candles: the Edge estimate needs five days of realised vol
    bars = { at: now, v: await fetchCandles('BTCUSD', '5m', Math.floor(now / 1000) - 6 * 86_400, Math.floor(now / 1000)) };
  }
  if (needHist && (!hist || now - hist.at > 45_000)) {
    const all = await loadSeries(now - 15 * 86_400_000).catch(() => [] as Sample[]);
    hist = { at: now, hist: all.filter((x) => x.t >= now - 26 * 3_600_000), clock: clockIv(all, now) };
  }
  const pulse = pulseSlot ? await pulseNow(pulseSlot).catch(() => null) : undefined;   // a failed read leaves no reading, so the condition holds the entry
  const g = evaluateGate();
  return {
    pulse,
    spot: chain.v.spot, chain: chain.v.options, expiries: chain.v.expiries,
    dvol: deribitWorker.currentDvol ?? null, gateGo: g.go, gateReasons: g.reasons,
    // the last bar is still forming: indicators use closed bars only
    bars5m: needBars && bars ? bars.v.slice(0, -1) : [],
    hist: needHist && hist ? hist.hist : undefined, clock: needHist && hist ? hist.clock : undefined,
  };
}

export const realAlgoDeps: AlgoDeps = {
  now: Date.now,
  armed: listArmed,
  openRuns,
  getRun,
  createRun,
  finishRun,
  disarm: async (uid, id) => { await setArmed(uid, id, false); },
  mark: recordMark,
  market: loadMarket,
  broker: (mode) => (mode === 'live' ? liveBroker : paperBroker),
};

export const algoEngine = new AlgoEngine(realAlgoDeps);

/**
 * One ATM IV / DVOL sample a minute for the "falling" and "IV vs clock" conditions, plus a DVOL backfill from Deribit on start.
 * ATM IV is that of the first live expiry (the current / 0DTE one).
 */
let sampler: NodeJS.Timeout | null = null;
export async function sampleOnce(now = Date.now()): Promise<void> {
  const m = await loadMarket(false);
  const iv = atmIvOf(defaultStrangle({ expiry: { mode: 'current' } }), m, now); // always the current expiry, whatever the default trade expiry is
  await recordSample({ t: now, atmIv: iv, dvol: deribitWorker.currentDvol ?? null, spot: m.spot });
}
export const seriesSampler = {
  start() {
    if (sampler) return;
    void backfillDvol().catch(() => undefined);
    sampler = setInterval(() => { void sampleOnce().catch(() => undefined); }, 60_000);
    sampler.unref?.();
  },
  stop() { if (sampler) clearInterval(sampler); sampler = null; },
};
