import { randomUUID } from 'node:crypto';
import { pool } from '../../db/index.js';
import { paperFor, marketFeed, type BasketLeg } from './paper-terminal.js';
import { type BoardRow, type MarketSnapshot } from './market.js';
import { SHORT_BAND, pickBodyLeg, type ChainOption } from '../../lib/bot/strike-picker.js';

/**
 * Professional Strangle Strategy (Paper Trading Only)
 *
 * Logic:
 * 1. Weekly Long Strangle:
 *    - On Friday, open a long strangle using the appropriate available next weekly expiry.
 *    - Keep this position as the longer-duration protection/structure.
 *
 * 2. Daily Short Strangle:
 *    - On Monday, Tuesday, and Wednesday, open a daily short strangle using the next-to-next available expiry (N2N).
 *    - Keep the daily short strangle separate from the weekly long strangle.
 *
 * Safety & Rules:
 * - Uses live available exchange contracts (no hard-coded dates).
 * - Prevents duplicate entries.
 * - Tracks strategy legs separately with metrics, Greeks, and P&L.
 * - Maintains paper-trading mode only (strictly zero real-money order placement).
 */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

export interface ISTTimeInfo {
  nowMs: number;
  istMs: number;
  dayOfWeek: number; // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  dayName: string;
  hour: number;
  minute: number;
  dateKey: string;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function getISTTime(ms: number = Date.now()): ISTTimeInfo {
  const istMs = ms + IST_OFFSET_MS;
  const d = new Date(istMs);
  const dayOfWeek = d.getUTCDay();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    nowMs: ms,
    istMs,
    dayOfWeek,
    dayName: DAY_NAMES[dayOfWeek] ?? 'Unknown',
    hour,
    minute,
    dateKey: `${year}-${month}-${day}`,
  };
}

export function formatExpiryDate(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

export function formatExpiryIso(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Find the next weekly expiry (Friday settlement at 17:30 IST / 12:00 UTC).
 * For weekly long strangles, we look for the next available weekly expiry >= 3.5 days away.
 */
export function findNextWeeklyExpiry(expiries: number[], nowMs: number = Date.now()): number | null {
  if (!expiries || !expiries.length) return null;
  const sorted = [...expiries].sort((a, b) => a - b);
  const minFutureMs = nowMs + 3.5 * 24 * 3600 * 1000;

  // Find expiries where IST day is Friday (dayOfWeek === 5)
  for (const exp of sorted) {
    if (exp >= minFutureMs) {
      const ist = getISTTime(exp);
      if (ist.dayOfWeek === 5) {
        return exp;
      }
    }
  }

  // Fallback: pick the first expiry >= 4 days in future, or the furthest available if all shorter
  const future = sorted.filter((e) => e >= minFutureMs);
  if (future.length) return future[0]!;
  return sorted[sorted.length - 1] ?? null;
}

/**
 * Find next-to-next (N2N) available expiry.
 * Index 1 in chronologically sorted active expiries.
 */
export function findN2NExpiry(expiries: number[], nowMs: number = Date.now()): number | null {
  if (!expiries || !expiries.length) return null;
  const valid = expiries.filter((e) => e > nowMs).sort((a, b) => a - b);
  if (valid.length >= 2) return valid[1]!;
  return valid[0] ?? null;
}

/** Convert BoardRow to ChainOption for strike picker */
function toChainOption(r: BoardRow): ChainOption {
  return {
    symbol: r.symbol,
    type: r.type,
    strike: r.strike,
    expiryMs: r.expiryMs,
    delta: Math.abs(r.delta || 0),
    bid: r.bid,
    ask: r.ask,
    mark: r.mark,
    iv: r.iv,
    gamma: r.gamma,
    theta: r.theta,
    vega: r.vega,
    oi: r.oi,
    volume: r.volume,
  };
}

/**
 * Pick strikes for Weekly Long Strangle (OTM Call + OTM Put, delta ~0.20-0.30 or closest OTM).
 */
export function pickWeeklyLongStrangle(rows: BoardRow[], expiryMs: number, spot: number): { call: BoardRow; put: BoardRow } | null {
  const expRows = rows.filter((r) => r.expiryMs === expiryMs && r.ask > 0);
  if (!expRows.length) return null;

  const calls = expRows.filter((r) => r.type === 'call' && r.strike >= spot);
  const puts = expRows.filter((r) => r.type === 'put' && r.strike <= spot);
  if (!calls.length || !puts.length) return null;

  // Target delta ~0.25 (range 0.18 - 0.35)
  const targetDelta = 0.25;
  const bestCall = calls.reduce((best, c) => {
    const dDiff = Math.abs(Math.abs(c.delta) - targetDelta);
    const bestDiff = Math.abs(Math.abs(best.delta) - targetDelta);
    return dDiff < bestDiff ? c : best;
  });

  const bestPut = puts.reduce((best, p) => {
    const dDiff = Math.abs(Math.abs(p.delta) - targetDelta);
    const bestDiff = Math.abs(Math.abs(best.delta) - targetDelta);
    return dDiff < bestDiff ? p : best;
  });

  return { call: bestCall, put: bestPut };
}

/**
 * Pick strikes for Daily Short Strangle (OTM Call + OTM Put, delta ~0.10-0.18).
 */
export function pickDailyShortStrangle(rows: BoardRow[], expiryMs: number, spot: number): { call: BoardRow; put: BoardRow } | null {
  const expRows = rows.filter((r) => r.expiryMs === expiryMs && r.bid > 0);
  if (!expRows.length) return null;

  const chain = expRows.map(toChainOption);
  const cOption = pickBodyLeg(chain, 'call', expiryMs, SHORT_BAND, 0.03, 0.03);
  const pOption = pickBodyLeg(chain, 'put', expiryMs, SHORT_BAND, 0.03, 0.03);

  const callRow = cOption ? expRows.find((r) => r.symbol === cOption.symbol) : null;
  const putRow = pOption ? expRows.find((r) => r.symbol === pOption.symbol) : null;

  if (callRow && putRow) {
    return { call: callRow, put: putRow };
  }

  // Fallback: pick closest strikes within 0.08 - 0.20 delta
  const calls = expRows.filter((r) => r.type === 'call' && r.strike > spot);
  const puts = expRows.filter((r) => r.type === 'put' && r.strike < spot);
  if (!calls.length || !puts.length) return null;

  const targetDelta = 0.125;
  const c = calls.reduce((b, x) => Math.abs(Math.abs(x.delta) - targetDelta) < Math.abs(Math.abs(b.delta) - targetDelta) ? x : b);
  const p = puts.reduce((b, x) => Math.abs(Math.abs(x.delta) - targetDelta) < Math.abs(Math.abs(b.delta) - targetDelta) ? x : b);

  return { call: c, put: p };
}

export interface ProfessionalStrangleStrategySummary {
  id: string;
  name: string;
  subType: 'weekly_long' | 'daily_short';
  status: string;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
  netPremium: number;
  grossPnl: number | null;
  netPnl: number | null;
  fees: number;
  legs: Array<{
    symbol: string;
    side: 'buy' | 'sell';
    lots: number;
    entry: number;
    mark: number | null;
    exit: number | null;
    stop: number | null;
    pnl: number | null;
    fee: number;
    delta?: number | null;
    gamma?: number | null;
    theta?: number | null;
    vega?: number | null;
    iv?: number | null;
  }>;
}

export interface ProfessionalStrangleState {
  today: {
    dayName: string;
    dayOfWeek: number;
    dateKey: string;
    isFriday: boolean;
    isDailyDay: boolean; // Mon (1), Tue (2), Wed (3)
  };
  eligibility: {
    weeklyLongEligible: boolean;
    dailyShortEligible: boolean;
    reason: string;
  };
  expiries: {
    nextWeeklyExpiry: number | null;
    nextWeeklyFormatted: string | null;
    n2nExpiry: number | null;
    n2nFormatted: string | null;
  };
  activeWeeklyLong: ProfessionalStrangleStrategySummary | null;
  activeDailyShort: ProfessionalStrangleStrategySummary | null;
  recentStrategies: ProfessionalStrangleStrategySummary[];
}

/**
 * Load complete Professional Strangle status for a user
 */
export async function getProfessionalStrangleState(userId: string): Promise<ProfessionalStrangleState> {
  const ist = getISTTime();
  const term = paperFor(userId);
  const strats = await term.strategies(20);

  const psList = [...strats.open, ...strats.closed].filter((s) => s.name.startsWith('Professional Strangle:'));

  const findSummary = (s: (typeof strats.open)[0]): ProfessionalStrangleStrategySummary => {
    const isWeekly = s.name.toLowerCase().includes('weekly long');
    return {
      id: s.id,
      name: s.name,
      subType: isWeekly ? 'weekly_long' : 'daily_short',
      status: s.status,
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      closeReason: s.closeReason,
      netPremium: s.netPremium,
      grossPnl: s.grossPnl,
      netPnl: s.netPnl,
      fees: s.fees,
      legs: s.legs.map((l) => ({
        symbol: l.symbol,
        side: l.side,
        lots: l.lots,
        entry: l.entry,
        mark: l.mark,
        exit: l.exit,
        stop: l.stop,
        pnl: l.pnl,
        fee: l.fee,
      })),
    };
  };

  const activeWeekly = strats.open.find((s) => s.name.startsWith('Professional Strangle: Weekly Long')) || null;
  const activeDaily = strats.open.find((s) => s.name.startsWith('Professional Strangle: Daily Short')) || null;

  // Check if daily short was entered today (IST calendar day)
  const todayStart = new Date(Date.now() + IST_OFFSET_MS);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime() - IST_OFFSET_MS;

  const enteredDailyToday = psList.some((s) => s.name.includes('Daily Short') && s.openedAt >= todayStartMs);

  let snap: MarketSnapshot | null = null;
  try {
    snap = await marketFeed().snapshot(3000);
  } catch {
    snap = null;
  }

  const nextWeekly = snap ? findNextWeeklyExpiry(snap.expiries) : null;
  const n2n = snap ? findN2NExpiry(snap.expiries) : null;

  const isFriday = ist.dayOfWeek === 5;
  const isDailyDay = ist.dayOfWeek === 1 || ist.dayOfWeek === 2 || ist.dayOfWeek === 3;

  const weeklyLongEligible = isFriday && !activeWeekly;
  const dailyShortEligible = isDailyDay && !activeDaily && !enteredDailyToday;

  let reason = '';
  if (isFriday) {
    reason = activeWeekly
      ? 'Friday: Weekly Long Strangle already open for this cycle.'
      : 'Friday: Eligible to open Weekly Long Strangle using next weekly expiry.';
  } else if (isDailyDay) {
    if (activeDaily) {
      reason = `${ist.dayName}: Daily Short Strangle currently active.`;
    } else if (enteredDailyToday) {
      reason = `${ist.dayName}: Daily Short Strangle already executed today.`;
    } else {
      reason = `${ist.dayName}: Eligible to open Daily Short Strangle using N2N expiry.`;
    }
  } else {
    reason = `${ist.dayName}: Holding/monitoring session. Scheduled entries run Friday (Weekly Long) and Mon/Tue/Wed (Daily Short).`;
  }

  return {
    today: {
      dayName: ist.dayName,
      dayOfWeek: ist.dayOfWeek,
      dateKey: ist.dateKey,
      isFriday,
      isDailyDay,
    },
    eligibility: {
      weeklyLongEligible,
      dailyShortEligible,
      reason,
    },
    expiries: {
      nextWeeklyExpiry: nextWeekly,
      nextWeeklyFormatted: nextWeekly ? formatExpiryIso(nextWeekly) : null,
      n2nExpiry: n2n,
      n2nFormatted: n2n ? formatExpiryIso(n2n) : null,
    },
    activeWeeklyLong: activeWeekly ? findSummary(activeWeekly) : null,
    activeDailyShort: activeDaily ? findSummary(activeDaily) : null,
    recentStrategies: psList.slice(0, 10).map(findSummary),
  };
}

export interface ExecutionResult {
  ok: boolean;
  reason?: string;
  strategyId?: string;
  name?: string;
  legs?: BasketLeg[];
  netPremium?: number;
  stops?: Array<number | null>;
}

/**
 * Execute Professional Strangle on Paper account
 */
export async function executeProfessionalStrangle(
  userId: string,
  mode: 'auto' | 'weekly_long' | 'daily_short' = 'auto',
  customLots: number = 100
): Promise<ExecutionResult> {
  const lots = Math.max(1, Math.min(100_000, Math.floor(customLots || 100)));
  const ist = getISTTime();
  const term = paperFor(userId);

  // 1. Determine execution target
  let targetMode = mode;
  if (targetMode === 'auto') {
    if (ist.dayOfWeek === 5) {
      targetMode = 'weekly_long';
    } else if (ist.dayOfWeek === 1 || ist.dayOfWeek === 2 || ist.dayOfWeek === 3) {
      targetMode = 'daily_short';
    } else {
      return {
        ok: false,
        reason: `No automated strategy entry scheduled for ${ist.dayName}. Automated schedule runs Weekly Long on Friday, and Daily Short on Monday, Tuesday, and Wednesday.`,
      };
    }
  }

  // 2. Load market data
  const snap = await marketFeed().snapshot(2000);
  if (!snap || !snap.expiries.length) {
    return { ok: false, reason: 'Live market data unavailable from Delta Exchange.' };
  }

  // 3. Prevent duplicate entries
  const existing = await term.strategies(20);
  if (targetMode === 'weekly_long') {
    const hasOpenWeekly = existing.open.some((s) => s.name.startsWith('Professional Strangle: Weekly Long'));
    if (hasOpenWeekly) {
      return { ok: false, reason: 'A Weekly Long Strangle is already open. Duplicate entry prevented.' };
    }

    const expiryMs = findNextWeeklyExpiry(snap.expiries);
    if (!expiryMs) {
      return { ok: false, reason: 'No suitable upcoming weekly expiry found on Delta.' };
    }

    const pair = pickWeeklyLongStrangle(snap.rows, expiryMs, snap.spot);
    if (!pair) {
      return { ok: false, reason: `Could not find liquid OTM call and put for expiry ${formatExpiryIso(expiryMs)}.` };
    }

    const expStr = formatExpiryDate(expiryMs);
    const stratName = `Professional Strangle: Weekly Long (${formatExpiryIso(expiryMs)})`;
    const legs: BasketLeg[] = [
      { symbol: pair.call.symbol, side: 'buy', lots, stop: null },
      { symbol: pair.put.symbol, side: 'buy', lots, stop: null },
    ];

    const res = await term.placeBasket(legs, stratName);
    if (!res.ok) {
      return { ok: false, reason: res.reason };
    }

    return {
      ok: true,
      strategyId: res.basketId,
      name: stratName,
      legs,
      netPremium: res.netPremium,
      stops: res.stops,
    };
  } else {
    // Daily Short Strangle
    const hasOpenDaily = existing.open.some((s) => s.name.startsWith('Professional Strangle: Daily Short'));
    if (hasOpenDaily) {
      return { ok: false, reason: 'A Daily Short Strangle is already open. Duplicate entry prevented.' };
    }

    const todayStart = new Date(Date.now() + IST_OFFSET_MS);
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime() - IST_OFFSET_MS;
    const alreadyEnteredToday = existing.open.concat(existing.closed).some(
      (s) => s.name.startsWith('Professional Strangle: Daily Short') && s.openedAt >= todayStartMs
    );
    if (alreadyEnteredToday && mode === 'auto') {
      return { ok: false, reason: 'Daily Short Strangle was already opened today. Duplicate entry prevented.' };
    }

    const expiryMs = findN2NExpiry(snap.expiries);
    if (!expiryMs) {
      return { ok: false, reason: 'No suitable N2N expiry contract found on Delta.' };
    }

    const pair = pickDailyShortStrangle(snap.rows, expiryMs, snap.spot);
    if (!pair) {
      return { ok: false, reason: `Could not find liquid short strangle strikes for N2N expiry ${formatExpiryIso(expiryMs)}.` };
    }

    const stratName = `Professional Strangle: Daily Short (${formatExpiryIso(expiryMs)})`;
    // 2x premium stop on short strangle
    const callStop = pair.call.bid > 0 ? pair.call.bid * 2 : pair.call.mark * 2;
    const putStop = pair.put.bid > 0 ? pair.put.bid * 2 : pair.put.mark * 2;

    const legs: BasketLeg[] = [
      { symbol: pair.call.symbol, side: 'sell', lots, stop: callStop },
      { symbol: pair.put.symbol, side: 'sell', lots, stop: putStop },
    ];

    const res = await term.placeBasket(legs, stratName);
    if (!res.ok) {
      return { ok: false, reason: res.reason };
    }

    return {
      ok: true,
      strategyId: res.basketId,
      name: stratName,
      legs,
      netPremium: res.netPremium,
      stops: res.stops,
    };
  }
}

/**
 * Close an active Professional Strangle strategy
 */
export async function closeProfessionalStrangle(userId: string, strategyId: string): Promise<{ ok: boolean; reason?: string }> {
  const term = paperFor(userId);
  return term.closeStrategy(strategyId, 'Professional Strangle closed by user');
}
