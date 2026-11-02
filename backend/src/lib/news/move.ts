/**
 * Is BTC moving abnormally, and is there news behind it?
 *
 * The Binance-night problem: price fell 2,700 in 15 minutes, there was a headline, and it looked like a spike.
 * This answers one question from price samples plus recent headlines:
 *   shock       = abnormal move AND a CRITICAL/HIGH headline in the last hour → real, exit
 *   unexplained = abnormal move, no headline yet → watch; news may follow
 *   normal      = nothing unusual
 */

export interface PricePoint { t: number; p: number }

export interface MoveRead {
  /** % change over the window (signed). */
  movePct: number;
  /** BTC points over the window (signed). */
  movePts: number;
  /** |move| divided by a normal move of the same length (from the baseline). */
  ratio: number;
  /** Typical |move| for this window length, in %. */
  normalPct: number;
}

const MIN = 60_000;

function priceAt(points: PricePoint[], t: number): number | null {
  // newest point at or before t
  let best: PricePoint | null = null;
  for (const pt of points) {
    if (pt.t <= t && (!best || pt.t > best.t)) best = pt;
  }
  return best ? best.p : null;
}

/**
 * Move over the last `windowMin` minutes against the median absolute move of the same length over the last
 * `baselineHours`. Median, not mean, so one earlier spike does not make the next one look normal.
 * Returns null without enough history.
 */
export function readMove(points: PricePoint[], now: number, windowMin = 15, baselineHours = 24): MoveRead | null {
  const pts = points.filter((x) => Number.isFinite(x.p) && x.p > 0 && x.t <= now).sort((a, b) => a.t - b.t);
  if (pts.length < 10) return null;
  const last = pts[pts.length - 1];
  if (now - last.t > 5 * MIN) return null; // stale
  const w = windowMin * MIN;
  const start = priceAt(pts, now - w);
  if (start == null) return null;

  const from = now - baselineHours * 3_600_000;
  const moves: number[] = [];
  for (let t = Math.max(from, pts[0].t) + w; t <= now - w; t += w / 3) {
    const a = priceAt(pts, t - w);
    const b = priceAt(pts, t);
    if (a && b) moves.push(Math.abs(b / a - 1) * 100);
  }
  if (moves.length < 12) return null;
  moves.sort((a, b) => a - b);
  const median = moves[Math.floor(moves.length / 2)];
  const normalPct = Math.max(median, 0.05); // floor: a dead-flat day must not turn 0.2 % into "10× normal"

  const movePct = (last.p / start - 1) * 100;
  return { movePct, movePts: last.p - start, ratio: Math.abs(movePct) / normalPct, normalPct };
}

export interface MoveThresholds {
  /** |move| must be at least this many times a normal move. */
  ratio: number;
  /** ...and at least this big in % (so a quiet night's wiggle never alarms). */
  minPct: number;
}

export const DEFAULT_MOVE: MoveThresholds = { ratio: 4, minPct: 1.2 };

export type MoveVerdict = 'shock' | 'unexplained' | 'normal';

export function judgeMove(read: MoveRead | null, hasShockHeadline: boolean, th: MoveThresholds = DEFAULT_MOVE): MoveVerdict {
  if (!read) return 'normal';
  const abnormal = read.ratio >= th.ratio && Math.abs(read.movePct) >= th.minPct;
  if (!abnormal) return 'normal';
  return hasShockHeadline ? 'shock' : 'unexplained';
}
