import { bs } from '../../backtest/lib/pricing.js';

/**
 * Approximation of Delta Exchange India's Portfolio Margin for BTC options (published method):
 *   margin = max(risk margin, margin floor)
 *   risk margin  = worst portfolio loss over 29 stress scenarios; scenarios 28-29 move price 3x the
 *                  span and count one third of their loss
 *   price / vol shock spans widen with total notional (tiers below)
 *   margin floor = short-option floor + long-option floor (+ futures floor)
 * Delta does not publish the exact scenario grid, so this uses a 9-point price grid x {vol down,
 * flat, vol up} (27) plus the two extremes (29). Paper mode only; testnet/live read the real
 * margin from Delta and the difference is logged as calibration error.
 */
export interface MarginPosition {
  type: 'call' | 'put';
  side: 'long' | 'short';
  strike: number;
  expiryMs: number;
  lots: number;
  /** Implied vol in vol points (e.g. 37.5). */
  iv: number;
}

export interface PortfolioMarginResult {
  margin: number;
  riskMargin: number;
  floor: number;
  notional: number;
  spans: { price: number; volDown: number; volUp: number };
  worstScenario: { priceMove: number; volShift: 'down' | 'flat' | 'up'; loss: number } | null;
}

const YEAR_MS = 365 * 86_400_000;

/**
 * The scenario model above under-states what Delta actually asks for: for 100 lots of a ~0.12 delta short strangle it gave
 * about $80 where Delta shows $100 to $300. Everything it returns is scaled by this one factor (default 2.5, so about $200)
 * (sold legs only) so the paper account, the chain's sell margin, the strategy builder and the bot's "% of margin" exits all use the same,
 * closer number. Change it with MARGIN_CALIBRATION once you have a real Delta figure to compare against.
 */
export const MARGIN_CALIBRATION = (() => {
  const v = Number(process.env.MARGIN_CALIBRATION ?? 2.5);
  return Number.isFinite(v) && v > 0 && v <= 20 ? v : 2.5;
})();

function tiered(notional: number, base: number, cap: number, slope: number, knee: number, atKnee: number): number {
  // base up to $100K, linear slope to the knee, then cap
  if (notional <= 100_000) return base;
  if (notional > knee) return cap;
  return Math.min(cap, atKnee + slope * (notional - 100_000));
}

export function shockSpans(notional: number): { price: number; volDown: number; volUp: number } {
  return {
    price: tiered(notional, 0.01, 0.1, 0.00000004, 2_350_000, 0.01),
    volDown: tiered(notional, 0.06, 0.3, 0.00000012, 2_100_000, 0.06),
    volUp: tiered(notional, 0.09, 0.45, 0.00000018, 2_100_000, 0.09),
  };
}

/** OM% for the margin floor: 0.5% base to $200K options notional, tiny slope, capped at 2% (BTC). */
function floorPct(optionsNotional: number): number {
  const base = 0.005;
  const slope = 0.0000005 / 100; // 0.0000005% per $ as a fraction
  const over = Math.max(0, optionsNotional - 200_000);
  return Math.min(0.02, base + slope * over);
}

function value(p: MarginPosition, spot: number, ivPts: number, nowMs: number): number {
  const T = Math.max((p.expiryMs - nowMs) / YEAR_MS, 1e-6);
  return bs(spot, p.strike, T, Math.max(ivPts, 0.5), p.type === 'call' ? 'c' : 'p');
}

export function portfolioMargin(
  positions: readonly MarginPosition[],
  spot: number,
  nowMs: number,
  contractValue = 0.001,
): PortfolioMarginResult {
  if (!positions.length) {
    return { margin: 0, riskMargin: 0, floor: 0, notional: 0, spans: shockSpans(0), worstScenario: null };
  }
  const notional = positions.reduce((s, p) => s + spot * p.lots * contractValue, 0);
  const spans = shockSpans(notional);

  const base = positions.map((p) => value(p, spot, p.iv, nowMs));
  const dteDays = (p: MarginPosition) => Math.max((p.expiryMs - nowMs) / 86_400_000, 0.05);
  const decay = (p: MarginPosition) => Math.pow(30 / dteDays(p), 0.3);

  const scenarioPnl = (priceMove: number, vol: 'down' | 'flat' | 'up'): number => {
    const s = spot * (1 + priceMove);
    let pnl = 0;
    positions.forEach((p, i) => {
      const k = vol === 'flat' ? 0 : vol === 'up' ? spans.volUp * decay(p) : -Math.min(spans.volDown * decay(p), 0.9);
      const v = value(p, s, p.iv * (1 + k), nowMs);
      const sign = p.side === 'long' ? 1 : -1;
      pnl += sign * (v - base[i]!) * p.lots * contractValue;
    });
    return pnl;
  };

  let riskMargin = 0;
  let worst: PortfolioMarginResult['worstScenario'] = null;
  const consider = (priceMove: number, vol: 'down' | 'flat' | 'up', weight: number) => {
    const loss = -scenarioPnl(priceMove, vol) * weight;
    if (loss > riskMargin) {
      riskMargin = loss;
      worst = { priceMove, volShift: vol, loss };
    }
  };
  for (let g = -4; g <= 4; g++) {
    for (const vol of ['down', 'flat', 'up'] as const) consider((g / 4) * spans.price, vol, 1);
  }
  consider(3 * spans.price, 'flat', 1 / 3);
  consider(-3 * spans.price, 'flat', 1 / 3);

  // Margin floor
  const shorts = positions.filter((p) => p.side === 'short');
  const longs = positions.filter((p) => p.side === 'long');
  const shortNotional = shorts.reduce((s, p) => s + spot * p.lots * contractValue, 0);
  const longNotional = longs.reduce((s, p) => s + spot * p.lots * contractValue, 0);
  const premiumOf = (p: MarginPosition) => base[positions.indexOf(p)]! * p.lots * contractValue;
  const mfShort = shorts.reduce((s, p) => {
    const n = spot * p.lots * contractValue;
    return s + Math.max(0.05 * premiumOf(p), floorPct(shortNotional) * n);
  }, 0);
  const mfLong = longs.reduce((s, p) => {
    const n = spot * p.lots * contractValue;
    return s + Math.min(premiumOf(p), Math.max(0.05 * premiumOf(p), floorPct(longNotional) * n));
  }, 0);
  const floor = mfShort + mfLong;

  // only positions with a sold leg are scaled: a bought option's margin is simply the premium paid, which the model already gets right
  const k = shorts.length ? MARGIN_CALIBRATION : 1;
  const w = worst as PortfolioMarginResult['worstScenario'];
  return { margin: Math.max(riskMargin, floor) * k, riskMargin: riskMargin * k, floor: floor * k, notional, spans, worstScenario: w ? { ...w, loss: w.loss * k } : null };
}
