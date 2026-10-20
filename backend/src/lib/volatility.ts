export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Garman-Klass realized volatility, annualized to a percentage, from 1-minute bars.
 * Formula per bar: 0.5*(ln(H/L))^2 - (2*ln2 - 1)*(ln(C/O))^2
 */
export function garmanKlassRv(bars: Bar[]): number {
  if (bars.length < 5) return 0;
  let sum = 0;
  for (const b of bars) {
    const hl = Math.log(b.high / b.low);
    const co = Math.log(b.close / b.open);
    sum += 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;
  }
  const variance = sum / bars.length;
  if (!(variance > 0)) return 0;
  const annualized = Math.sqrt(variance * 525600) * 100; // 525600 minutes per year
  return Number.isFinite(annualized) ? annualized : 0;
}

/**
 * Absolute percentage move of the latest close versus the close `window` bars earlier.
 */
export function computeVelocityPct(closes: number[], window: number): number {
  if (closes.length <= window) return 0;
  const now = closes[closes.length - 1];
  const past = closes[closes.length - 1 - window];
  if (!(past > 0) || !Number.isFinite(now)) return 0;
  return Math.abs((now - past) / past) * 100;
}
