/**
 * How close a stop is, in option points (the same unit as the option's price: a call sold at 100 with a stop at 200 and a mark of 183 has 17
 * points left). One definition used by every source of positions (the paper bot, paper strategies, real Delta positions) and by the alarm.
 */
export interface WatchSettings {
  /** The full-screen alarm starts when this many points or fewer are left before the stop. */
  warnPoints: number;
  /** The hard exit closes every leg when this many points or fewer are left. */
  hardPoints: number;
  /** For real Delta positions the desk does not know your stop, so it uses entry price x this multiple (default 2x). */
  stopMultiple: number;
}

export const DEFAULT_WATCH: WatchSettings = { warnPoints: 20, hardPoints: 5, stopMultiple: 2 };

export type Level = 'safe' | 'warn' | 'hard' | 'breach';

export interface WatchLeg {
  /** Where the leg comes from. */
  source: 'bot' | 'paper' | 'delta';
  /** Groups the legs of one position (a bot run, a paper strategy, one expiry on Delta). */
  group: string;
  groupLabel: string;
  symbol: string;
  /** "sold" legs lose when the mark rises to the stop, "bought" legs when it falls to it. */
  side: 'sold' | 'bought';
  entry: number;
  mark: number | null;
  stop: number;
  lots: number;
}

export interface LegStatus extends WatchLeg {
  /** Points between the mark and the stop (zero or negative once the stop is reached). Null when there is no price. */
  pointsLeft: number | null;
  level: Level;
}

export function pointsLeft(leg: Pick<WatchLeg, 'side' | 'mark' | 'stop'>): number | null {
  if (leg.mark == null || !Number.isFinite(leg.mark)) return null;
  return leg.side === 'sold' ? leg.stop - leg.mark : leg.mark - leg.stop;
}

/**
 * The level for a number of points left. `previous` adds a little hysteresis so the alarm does not flicker around the line:
 * once it has started it only clears when the leg is 2 points (or 10% of the warning distance, whichever is larger) beyond it.
 */
export function levelFor(points: number | null, s: WatchSettings, previous: Level = 'safe'): Level {
  if (points == null) return previous === 'safe' ? 'safe' : previous;
  if (points <= 0) return 'breach';
  if (points <= s.hardPoints) return 'hard';
  const clear = s.warnPoints + Math.max(2, s.warnPoints * 0.1);
  if (points <= s.warnPoints) return 'warn';
  if (previous !== 'safe' && points <= clear) return 'warn';
  return 'safe';
}

export function statusOf(leg: WatchLeg, s: WatchSettings, previous: Level = 'safe'): LegStatus {
  const pts = pointsLeft(leg);
  return { ...leg, pointsLeft: pts, level: levelFor(pts, s, previous) };
}

const RANK: Record<Level, number> = { safe: 0, warn: 1, hard: 2, breach: 3 };
export const worst = (levels: readonly Level[]): Level => levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), 'safe');
export const isAlarm = (l: Level): boolean => l !== 'safe';

export function normaliseSettings(raw: Partial<WatchSettings> | null | undefined): WatchSettings {
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const warn = num(raw?.warnPoints, 1, 500, DEFAULT_WATCH.warnPoints);
  const hard = Math.min(num(raw?.hardPoints, 0, 200, DEFAULT_WATCH.hardPoints), warn); // the hard exit can never be earlier than the warning
  return { warnPoints: warn, hardPoints: hard, stopMultiple: num(raw?.stopMultiple, 1.1, 10, DEFAULT_WATCH.stopMultiple) };
}
