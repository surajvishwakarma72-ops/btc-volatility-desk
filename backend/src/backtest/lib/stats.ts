/**
 * Statistics toolkit for the backtest: distribution summaries, effect size,
 * correlation, and classification precision/recall.
 */
export const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export function std(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}

export function percentile(a: number[], p: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}
export const median = (a: number[]) => percentile(a, 50);

/** Cohen's d effect size between two samples (pooled sd). */
export function cohenD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const sa = std(a), sb = std(b);
  const pooled = Math.sqrt(((a.length - 1) * sa * sa + (b.length - 1) * sb * sb) / (a.length + b.length - 2));
  return pooled > 0 ? (mean(a) - mean(b)) / pooled : 0;
}

/** Pearson correlation. */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

/** Point-biserial correlation between a boolean label and a continuous var. */
export function pointBiserial(flags: boolean[], xs: number[]): number {
  return pearson(flags.map((f) => (f ? 1 : 0)), xs);
}

export interface PRResult {
  precision: number; // P(actual | predicted)
  recall: number; // P(predicted | actual)
  f1: number;
  support: number; // # predicted true
  lift: number; // precision / base rate
}

/** Precision/recall of a boolean predictor for a boolean actual label. */
export function precisionRecall(predicted: boolean[], actual: boolean[]): PRResult {
  let tp = 0, fp = 0, fn = 0, pos = 0;
  for (let i = 0; i < predicted.length; i++) {
    if (actual[i]) pos++;
    if (predicted[i] && actual[i]) tp++;
    else if (predicted[i] && !actual[i]) fp++;
    else if (!predicted[i] && actual[i]) fn++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = pos > 0 ? tp / pos : 0;
  const base = predicted.length ? pos / predicted.length : 0;
  return {
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    support: tp + fp,
    lift: base > 0 ? precision / base : 0,
  };
}

/** 2x2 chi-square with Yates correction (verbatim from stage1_rigorous_validation). */
export function chi2Yates(a: number, b: number, c: number, d: number): { chi2: number; n: number } {
  const n = a + b + c + d;
  const num = Math.pow(Math.max(0, Math.abs(a * d - b * c) - n / 2), 2) * n;
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  return { chi2: den > 0 ? num / den : 0, n };
}
