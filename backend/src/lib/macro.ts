/**
 * Pure maths for the Macro Stress lane: quote freshness, market moves, correlation with BTC, news-event weighting and
 * the score. The worker feeds it data; nothing here does I/O or reads the clock.
 */
export interface Pt {
  t: number;
  p: number;
}

/** A market whose newest 5-minute candle is older than this is treated as closed, not as calm. */
export const MARKET_STALE_MS = 45 * 60_000;

/** The price nearest `target`, but only if it is within `tolMs` of it. */
export function priceNear(points: readonly Pt[], target: number, tolMs: number): number | null {
  let best: Pt | null = null;
  for (const q of points) {
    const d = Math.abs(q.t - target);
    if (d <= tolMs && (!best || d < Math.abs(best.t - target))) best = q;
  }
  return best ? best.p : null;
}

export interface MoveRead {
  /** The market is trading now (fresh candles). */
  open: boolean;
  ageMin: number;
  change1hPct: number;
  change4hPct: number;
  /** True when the 1h or 4h reference price was missing, so that move counts as zero. */
  partial: boolean;
}

export function readMoves(points: readonly Pt[], price: number, nowMs: number): MoveRead {
  const last = points[points.length - 1];
  const age = last ? nowMs - last.t : Infinity;
  if (!last || age > MARKET_STALE_MS) return { open: false, ageMin: Number.isFinite(age) ? age / 60_000 : Infinity, change1hPct: 0, change4hPct: 0, partial: true };
  const p1 = priceNear(points, nowMs - 3_600_000, 20 * 60_000);
  const p4 = priceNear(points, nowMs - 4 * 3_600_000, 30 * 60_000);
  const pct = (ref: number | null) => (ref != null && ref > 0 ? ((price - ref) / ref) * 100 : 0);
  return { open: true, ageMin: age / 60_000, change1hPct: pct(p1), change4hPct: pct(p4 ?? p1), partial: p1 == null || p4 == null };
}

/** Hourly log returns keyed by the hour (ms): last price in each hour against the last price of the hour before. */
export function hourlyReturns(points: readonly Pt[]): Map<number, number> {
  const closeOf = new Map<number, number>();
  for (const q of points) closeOf.set(Math.floor(q.t / 3_600_000), q.p);
  const out = new Map<number, number>();
  for (const [h, c] of closeOf) {
    const prev = closeOf.get(h - 1);
    if (prev && prev > 0 && c > 0) out.set(h, Math.log(c / prev));
  }
  return out;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

export const MIN_LINK_HOURS = 30;

/** Correlation of a market's hourly returns with BTC's over the hours both traded, and how many hours that was. */
export function correlationWithBtc(market: ReadonlyMap<number, number>, btc: ReadonlyMap<number, number>): { corr: number | null; hours: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [h, r] of market) { const b = btc.get(h); if (b != null) { xs.push(r); ys.push(b); } }
  return { corr: xs.length >= MIN_LINK_HOURS ? pearson(xs, ys) : null, hours: xs.length };
}

/**
 * How tied a market group is to BTC, 0 to 1. The strength of the relationship matters, not its sign (the VIX moves
 * against BTC and still transmits stress), so it uses |correlation|. With little data it falls back to the prior,
 * and it is always half prior, half measured so a few quiet days cannot swing it.
 */
export function blendLink(corrs: ReadonlyArray<number | null>, prior: number): number {
  const ok = corrs.filter((c): c is number => c != null);
  if (!ok.length) return prior;
  const measured = Math.min(1, ok.reduce((s, c) => s + Math.abs(c), 0) / ok.length);
  return 0.5 * prior + 0.5 * measured;
}

export type Impact = 'High' | 'Medium' | 'Low' | 'Holiday';

export interface RawEvent {
  title?: string;
  country?: string;
  impact?: string;
  date?: string;
}

/** Hours from now at which an event sits, positive = ahead. */
export const hoursUntil = (eventMs: number, nowMs: number) => (eventMs - nowMs) / 3_600_000;

/** 0 to 1: ramps up over the 6 hours before the event, decays over the 2 hours after; Medium impact counts 60%. */
export function eventFactor(diffHours: number, impact: Impact): number {
  let f = 0;
  if (diffHours >= 0 && diffHours <= 6) f = (6 - diffHours) / 6;
  else if (diffHours < 0 && diffHours >= -2) f = (2 - Math.abs(diffHours)) / 2;
  return impact === 'Medium' ? f * 0.6 : f;
}

/**
 * The calendar feed lists every currency's releases. Only US releases move BTC volatility on the desk's rule
 * (CPI, FOMC, jobs and the like), so other countries' events are ignored. High and Medium impact only,
 * within 2 hours back to 18 hours ahead.
 */
export function relevantEvents(items: readonly RawEvent[], nowMs: number): Array<{ title: string; impact: 'High' | 'Medium'; timestamp: number; hoursUntil: number; factor: number }> {
  const out: Array<{ title: string; impact: 'High' | 'Medium'; timestamp: number; hoursUntil: number; factor: number }> = [];
  for (const it of items) {
    if ((it.country || '').toUpperCase() !== 'USD') continue;
    const impact = it.impact === 'High' || it.impact === 'Medium' ? it.impact : null;
    if (!impact || !it.date) continue;
    const ts = new Date(it.date).getTime();
    if (Number.isNaN(ts)) continue;
    const d = hoursUntil(ts, nowMs);
    if (d < -2 || d > 18) continue;
    out.push({ title: it.title || 'US release', impact, timestamp: ts, hoursUntil: d, factor: eventFactor(d, impact) });
  }
  return out.sort((a, b) => Math.abs(a.hoursUntil) - Math.abs(b.hoursUntil));
}

export interface StressInputs {
  press: { forex: number; commodities: number; equities: number; bonds: number; event: number };
  weights: { forex: number; commodities: number; equities: number; bonds: number; event: number };
}

/**
 * Weighted sum of the pressures, scaled to 0-100 and kept inside 12..96. The news calendar enters once, through
 * its own pressure and weight (an imminent high-impact US release alone reads amber, never red).
 */
export function stressScore(i: StressInputs): number {
  const w = i.weights, p = i.press;
  const sum = w.forex * p.forex + w.commodities * p.commodities + w.equities * p.equities + w.bonds * p.bonds + w.event * p.event;
  return Math.max(12, Math.min(96, Math.round(Math.min(100, Math.max(0, sum * 55)))));
}
