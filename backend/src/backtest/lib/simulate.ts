/**
 * Short-strangle overnight simulation (BS-repriced legs; no historical option prices).
 *
 * Entry: 10-15Δ call+put on the N2N (3rd) expiry, repriced from ATM IV.
 * Stop: per-leg mark >= 2x entry premium (checked on 1m intrabar extremes); exit BOTH.
 * Target: net P&L >= targetPct of margin -> exit. Hard time-exit at 07:00 IST.
 * Fees/slippage: fixed per-leg buffer (no historical bid/ask); bid-ask>1.5% reject is
 * live-only and NOT modeled here (documented in the plan).
 */
import { bs, strike, roundStrike, bsDelta, yrs } from './pricing.js';
import { MIN } from './frame.js';
import type { Frame } from './frame.js';
import type { BacktestData } from '../data/load.js';

export interface SimConfig {
  deltaCall: number;
  deltaPut: number;
  contractBTC: number; // 100 lots x 0.001 BTC/lot = 0.1 BTC per leg
  marginUsd: number;
  targetPct: number; // fraction of margin for profit target (0.10)
  reachPct: number; // secondary "was 12% reachable" probe (0.12)
  feePerLegUsd: number; // round-trip fee+slippage buffer per leg
  stopBufferRatio: number; // silence proxy: never came within this ratio of 2x
}

export const DEFAULT_SIM: SimConfig = {
  deltaCall: 0.15,
  deltaPut: 0.15,
  contractBTC: 0.1,
  marginUsd: 87,
  targetPct: 0.1,
  reachPct: 0.12,
  feePerLegUsd: 1.75, // calibrated: avg SL ≈ ₹1000 (your live ₹1000-1200 band)
  stopBufferRatio: 1.6,
};

export type Outcome = 'TARGET' | 'TIME-WIN' | 'TIME-LOSS' | 'SL-CALL' | 'SL-PUT' | 'NO-DATA';

export interface SimResult {
  ok: boolean;
  outcome: Outcome;
  entryMs: number;
  exitMs: number;
  spot0: number;
  iv0: number;
  Kc: number;
  Kp: number;
  c0: number;
  p0: number;
  credit: number;
  deltaCActual: number;
  deltaPActual: number;
  stopped: boolean;
  hurtLeg: 'CALL' | 'PUT' | 'NONE';
  pnlUsd: number;
  pnlPctCredit: number;
  pnlPctMargin: number;
  reachable12: boolean;
  maeUsd: number;
  mfeUsd: number;
  btcMovePct: number;
  silence: boolean;
}

function noData(entryMs: number): SimResult {
  return {
    ok: false, outcome: 'NO-DATA', entryMs, exitMs: entryMs, spot0: 0, iv0: 0,
    Kc: 0, Kp: 0, c0: 0, p0: 0, credit: 0, deltaCActual: 0, deltaPActual: 0,
    stopped: false, hurtLeg: 'NONE', pnlUsd: 0, pnlPctCredit: 0, pnlPctMargin: 0,
    reachable12: false, maeUsd: 0, mfeUsd: 0, btcMovePct: 0, silence: false,
  };
}

export function simulateStrangle(
  data: BacktestData,
  f: Frame,
  entryMs: number,
  cfg: SimConfig = DEFAULT_SIM,
): SimResult {
  const settle = f.settle;
  const spot0 = data.entrySpot(entryMs);
  const iv0 = data.ivAt(f.n2n, entryMs);
  const T0 = yrs(settle - entryMs);
  if (spot0 == null || iv0 == null || !(iv0 > 0) || T0 <= 0) return noData(entryMs);

  const Kc = roundStrike(strike(spot0, T0, iv0, cfg.deltaCall, 'c'), spot0, 'c');
  const Kp = roundStrike(strike(spot0, T0, iv0, cfg.deltaPut, 'p'), spot0, 'p');
  const c0 = bs(spot0, Kc, T0, iv0, 'c');
  const p0 = bs(spot0, Kp, T0, iv0, 'p');
  const credit = c0 + p0;
  if (!(credit > 0)) return noData(entryMs);

  const fee = 2 * cfg.feePerLegUsd; // both legs close
  const targetUsd = cfg.targetPct * cfg.marginUsd;
  const reach12Usd = cfg.reachPct * cfg.marginUsd;

  const bars = data.bars1mBetween(entryMs + MIN, f.exit);

  let outcome: Outcome = 'TIME-WIN';
  let exitMs = f.exit;
  let stopped = false;
  let hurtLeg: 'CALL' | 'PUT' | 'NONE' = 'NONE';
  let pnlUsd = 0;
  let maeUsd = 0; // most negative running net
  let mfeUsd = 0; // most positive running net
  let reachable12 = false;
  let maxMarkRatio = 0; // worst (callHigh/c0 or putLow/p0) during hold — for silence proxy
  let btcHi = spot0, btcLo = spot0;
  let settled = false;

  for (const b of bars) {
    const t = b.t;
    const T = yrs(settle - t);
    const iv = data.ivAt(f.n2n, t) ?? iv0;
    btcHi = Math.max(btcHi, b.h);
    btcLo = Math.min(btcLo, b.l);

    // Worst-case intrabar marks: call richest at the high, put richest at the low.
    const callHigh = bs(b.h, Kc, T, iv, 'c');
    const putLow = bs(b.l, Kp, T, iv, 'p');
    maxMarkRatio = Math.max(maxMarkRatio, callHigh / c0, putLow / p0);

    // Conservative worst-case running drawdown (both extremes).
    const worstBuyback = callHigh + putLow;
    const netWorst = (credit - worstBuyback) * cfg.contractBTC - fee;
    if (netWorst < maeUsd) maeUsd = netWorst;

    // 1) Stop-loss (risk first) on intrabar extremes.
    if (callHigh >= 2 * c0) {
      stopped = true; hurtLeg = 'CALL'; outcome = 'SL-CALL'; exitMs = t;
      const putMark = bs(b.c, Kp, T, iv, 'p');
      pnlUsd = (credit - (2 * c0 + putMark)) * cfg.contractBTC - fee;
      settled = true; break;
    }
    if (putLow >= 2 * p0) {
      stopped = true; hurtLeg = 'PUT'; outcome = 'SL-PUT'; exitMs = t;
      const callMark = bs(b.c, Kc, T, iv, 'c');
      pnlUsd = (credit - (callMark + 2 * p0)) * cfg.contractBTC - fee;
      settled = true; break;
    }

    // 2) Profit target on the bar close.
    const callClose = bs(b.c, Kc, T, iv, 'c');
    const putClose = bs(b.c, Kp, T, iv, 'p');
    const netClose = (credit - (callClose + putClose)) * cfg.contractBTC - fee;
    if (netClose > mfeUsd) mfeUsd = netClose;
    if (netClose >= reach12Usd) reachable12 = true;
    if (netClose >= targetUsd) {
      outcome = 'TARGET'; exitMs = t; pnlUsd = netClose; settled = true; break;
    }
  }

  if (!settled) {
    // Time exit at 07:00 IST (last available bar close).
    const last = bars.length ? bars[bars.length - 1] : null;
    if (!last) return noData(entryMs);
    const T = yrs(settle - last.t);
    const iv = data.ivAt(f.n2n, last.t) ?? iv0;
    const callClose = bs(last.c, Kc, T, iv, 'c');
    const putClose = bs(last.c, Kp, T, iv, 'p');
    pnlUsd = (credit - (callClose + putClose)) * cfg.contractBTC - fee;
    exitMs = last.t;
    outcome = pnlUsd > 0 ? 'TIME-WIN' : 'TIME-LOSS';
  }

  const btcMovePct = (Math.max(btcHi - spot0, spot0 - btcLo) / spot0) * 100;
  // Price-only silence proxy: never came within stopBufferRatio of a 2x leg blowout.
  const silence = !stopped && maxMarkRatio < cfg.stopBufferRatio;

  return {
    ok: true,
    outcome,
    entryMs,
    exitMs,
    spot0,
    iv0,
    Kc,
    Kp,
    c0,
    p0,
    credit,
    deltaCActual: bsDelta(spot0, Kc, T0, iv0, 'c'),
    deltaPActual: bsDelta(spot0, Kp, T0, iv0, 'p'),
    stopped,
    hurtLeg,
    pnlUsd,
    pnlPctCredit: (pnlUsd / (credit * cfg.contractBTC)) * 100,
    pnlPctMargin: (pnlUsd / cfg.marginUsd) * 100,
    reachable12,
    maeUsd,
    mfeUsd,
    btcMovePct,
    silence,
  };
}
