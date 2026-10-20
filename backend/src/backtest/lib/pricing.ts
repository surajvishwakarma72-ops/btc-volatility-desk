/**
 * Option pricing + session-frame math for the stop-loss-elimination backtest.
 *
 * These are VERBATIM copies of the proven formulas in
 * `backend/src/scripts/stage1_backtest.ts` (ncdf/ppf/bs/strike/frame/rvOver/at),
 * copied here so the backtest is self-contained and does not execute that script's
 * `main()` / DB imports. Do not "improve" them — they must match the live desk.
 */

export const MIN = 60_000;
export const HR = 3_600_000;
export const DAY = 86_400_000;
export const IST = 19_800_000; // UTC + 5.5h in ms

/** Standard normal CDF (Abramowitz-Stegun), exact copy from stage1_backtest.ts. */
export function ncdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Standard normal PPF (inverse CDF), exact copy from stage1_backtest.ts. */
export function ppf(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Black-Scholes price (s in vol %, T in years), exact copy from stage1_backtest.ts. */
export function bs(S: number, K: number, T: number, s: number, cp: 'c' | 'p'): number {
  T = Math.max(T, 1e-6);
  s = Math.max(s, 0.01) / 100;
  const v = s * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * s * s * T) / v;
  const d2 = d1 - v;
  return cp === 'c' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
}

/** Delta-targeted strike (raw, ungridded), exact copy from stage1_backtest.ts. */
export function strike(S: number, T: number, s: number, dl: number, cp: 'c' | 'p'): number {
  s = s / 100;
  const d1 = cp === 'c' ? ppf(dl) : ppf(1 - dl);
  return S * Math.exp(-(d1 * s * Math.sqrt(T) - 0.5 * s * s * T));
}

/** Round to Delta Exchange's strike grid ($500 above $50k, else $250). */
export function roundStrike(raw: number, S: number, cp: 'c' | 'p'): number {
  const grid = S > 50_000 ? 500 : 250;
  return cp === 'c' ? Math.ceil(raw / grid) * grid : Math.floor(raw / grid) * grid;
}

/** BS option delta (call in [0,1], put in [-1,0]) — for logging the actual leg delta. */
export function bsDelta(S: number, K: number, T: number, s: number, cp: 'c' | 'p'): number {
  T = Math.max(T, 1e-6);
  const sig = Math.max(s, 0.01) / 100;
  const v = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v;
  return cp === 'c' ? ncdf(d1) : ncdf(d1) - 1;
}

export const yrs = (ms: number) => ms / (365 * DAY);
