import { REGIME_GATE_CONFIG } from '../../lib/pulse/config.js';
import { evaluateRegimeGate, type GateInputs, type RegimeGateResult } from '../../lib/pulse/regime/gate.js';
import { hourReturns, regimeState, rvWindow, type Bar1h } from '../../lib/pulse/regime/indicators.js';
import { deribitWorker } from '../deribit-flow-worker.js';
import { macroStressWorker } from '../macro-stress-worker.js';
import { hourlyBars, type HourlyBars } from './hourly-bars.js';

const CACHE_MS = 60_000;

export interface RegimeDeps {
  bars: { completed(nowMs: number): Bar1h[]; status(): ReturnType<HourlyBars['status']> };
  dvol(): { value: number; at: number } | null;
  macro(): GateInputs['macro'];
  now(): number;
}

export interface RegimeServiceOptions {
  /** Fewest completed bars before bar inputs are trusted. */
  minBars: number;
}

export type RegimeSnapshot = RegimeGateResult & { bars: ReturnType<HourlyBars['status']> };

function realDvol(): { value: number; at: number } | null {
  const value = deribitWorker.currentDvol;
  const at = deribitWorker.lastDvolAt;
  return value != null && at != null ? { value, at } : null;
}

function realMacro(): GateInputs['macro'] {
  const s = macroStressWorker.getSnapshot();
  return { hasData: s.hasData, status: s.status, nextEvent: s.nextEvent };
}

/** Read-only live regime gate: completed hourly bars, DVOL and the macro calendar, evaluated at most once a minute. */
export class RegimeService {
  private readonly deps: RegimeDeps;
  private readonly opts: RegimeServiceOptions;
  private cached: { at: number; result: RegimeSnapshot } | null = null;

  constructor(deps: Partial<RegimeDeps> = {}, opts: Partial<RegimeServiceOptions> = {}) {
    this.deps = { bars: hourlyBars, dvol: realDvol, macro: realMacro, now: () => Date.now(), ...deps };
    this.opts = { minBars: opts.minBars ?? REGIME_GATE_CONFIG.minBars };
  }

  snapshot(nowMs: number = this.deps.now()): RegimeSnapshot {
    if (this.cached && nowMs >= this.cached.at && nowMs - this.cached.at < CACHE_MS) return this.cached.result;

    const bars = this.deps.bars.completed(nowMs);
    // Too little history for the RVP window: treat every bar-based input as unavailable rather than half-computed.
    const enough = bars.length > 0 && bars.length >= this.opts.minBars;
    const gate = evaluateRegimeGate({
      nowMs,
      dvol: this.deps.dvol(),
      barsNewestOpenMs: enough ? bars[bars.length - 1]!.t : null,
      state: enough ? regimeState(bars, nowMs) : null,
      rv24: enough ? rvWindow(hourReturns(bars, nowMs), nowMs, REGIME_GATE_CONFIG.rvHours) : null,
      macro: this.deps.macro(),
    });
    const result: RegimeSnapshot = { ...gate, bars: this.deps.bars.status() };
    this.cached = { at: nowMs, result };
    return result;
  }
}

export const regimeService = new RegimeService();
