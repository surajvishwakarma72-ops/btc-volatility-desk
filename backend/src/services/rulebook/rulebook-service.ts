/**
 * Rule Book service: gathers the live readings for the before-entry checklist and keeps the user's equity, rule breaks
 * (half size for the next trades), daily-stop unlocks and the trade journal. Read-only towards the exchange.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../db/index.js';
import { defaultStrangle } from '../../lib/algo/rule.js';
import { evaluateChecklist, topTierReleases, type ChecklistInput, type ChecklistResult, type LegQuote } from '../../lib/rulebook/checklist.js';
import { expectedNfp, releaseKind, tonight, type Release, type Tonight } from '../../lib/calendar/tonight.js';
import { istDate } from '../../lib/calendar/time.js';
import { volChecks, type VolRead } from '../../lib/vol/regime.js';
import { volRead } from '../vol/vol-history.js';
import { RULEBOOK_CONFIG as CFG } from '../../lib/rulebook/config.js';
import { buildPlan } from '../algo/algo-engine.js';
import { loadMarket } from '../algo/algo-runtime.js';
import { loadUsEvents } from '../algo/event-guard.js';
import { newsWatcher } from '../news/index.js';
import { pulseNow } from '../pulse/pulse-score.js';
import { regimeService } from '../pulse/regime-service.js';

const H = 3_600_000;
const IST = 5.5 * H;

/** Exit reasons that count toward the daily stop (an exit forced by a rule, not a planned take-profit). */
export const RULE_EXITS = ['1:1 stop', 'CRITICAL news', 'Killer pattern', 'Zone avoid / GoGo exit', 'Tested leg', 'Compression break'] as const;
export const EXIT_REASONS = ['Take profit', 'Time exit', ...RULE_EXITS, 'Other'] as const;

export const istDayKey = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const istWeekday = (ms: number) => new Date(ms + IST).getUTCDay(); // 0 Sun

let ready: Promise<void> | null = null;
export async function ensureRulebookSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rulebook_state (
          user_id text PRIMARY KEY,
          equity_usd numeric,
          half_left integer NOT NULL DEFAULT 0,
          unlocked_day text,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS rulebook_breaks (
          id uuid PRIMARY KEY,
          user_id text NOT NULL,
          at timestamptz NOT NULL,
          rules jsonb NOT NULL DEFAULT '[]',
          note text
        );
        CREATE INDEX IF NOT EXISTS idx_rulebook_breaks_user_at ON rulebook_breaks(user_id, at DESC);
        CREATE TABLE IF NOT EXISTS rulebook_journal (
          id uuid PRIMARY KEY,
          user_id text NOT NULL,
          at timestamptz NOT NULL,
          day_key text NOT NULL,
          entry jsonb NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rulebook_journal_user_at ON rulebook_journal(user_id, at DESC);
      `);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export interface RulebookState { equityUsd: number | null; halfLeft: number; unlockedDay: string | null }

export async function getState(userId: string): Promise<RulebookState> {
  await ensureRulebookSchema();
  const r = await pool.query('SELECT equity_usd, half_left, unlocked_day FROM rulebook_state WHERE user_id = $1', [userId]);
  const row = r.rows[0] as { equity_usd: string | null; half_left: number; unlocked_day: string | null } | undefined;
  return { equityUsd: row?.equity_usd != null ? Number(row.equity_usd) : null, halfLeft: row?.half_left ?? 0, unlockedDay: row?.unlocked_day ?? null };
}

async function putState(userId: string, s: Partial<RulebookState>): Promise<RulebookState> {
  const cur = await getState(userId);
  const next = { ...cur, ...s };
  await pool.query(
    `INSERT INTO rulebook_state (user_id, equity_usd, half_left, unlocked_day, updated_at) VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id) DO UPDATE SET equity_usd = EXCLUDED.equity_usd, half_left = EXCLUDED.half_left, unlocked_day = EXCLUDED.unlocked_day, updated_at = now()`,
    [userId, next.equityUsd, next.halfLeft, next.unlockedDay],
  );
  return next;
}

export const setEquity = (userId: string, equityUsd: number) => putState(userId, { equityUsd });

/** Unlock today's daily stop. The caller has already checked the typed confirmation. */
export const unlockToday = (userId: string, now = Date.now()) => putState(userId, { unlockedDay: istDayKey(now) });

/** A trade placed against a red checklist: logged, and the next trades go at half size. */
export async function logRuleBreak(userId: string, rules: string[], note: string | null, now = Date.now()): Promise<void> {
  await ensureRulebookSchema();
  await pool.query('INSERT INTO rulebook_breaks (id, user_id, at, rules, note) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), userId, new Date(now), JSON.stringify(rules), note]);
  await putState(userId, { halfLeft: CFG.halfSizeTrades });
}

export async function recentBreaks(userId: string, limit = 50) {
  await ensureRulebookSchema();
  const r = await pool.query('SELECT id, at, rules, note FROM rulebook_breaks WHERE user_id = $1 ORDER BY at DESC LIMIT $2', [userId, limit]);
  return r.rows.map((x: any) => ({ id: x.id, at: new Date(x.at).getTime(), rules: typeof x.rules === 'string' ? JSON.parse(x.rules) : x.rules, note: x.note }));
}

export interface JournalEntry {
  expiry?: string;
  callDelta?: number | null;
  putDelta?: number | null;
  lots?: number | null;
  riskPct?: number | null;
  exitAt?: number | null;
  exitReason: (typeof EXIT_REASONS)[number];
  netPnlUsd: number;
  peakUsd?: number | null;
  maxDrawdownUsd?: number | null;
  rulesBroken?: string;
  lesson?: string;
  /** Filled in by the server: the gate readings when the entry was logged. */
  gates?: Record<string, string>;
  session?: string;
  weekday?: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function sessionOf(ms: number): string {
  const m = (new Date(ms + IST).getUTCHours() * 60) + new Date(ms + IST).getUTCMinutes();
  if (m >= 5 * 60 + 30 && m < 13 * 60 + 30) return 'Asia';
  if (m >= 13 * 60 + 30 && m < 19 * 60 + 30) return 'London';
  if (m >= 19 * 60 + 30 && m < 22 * 60 + 30) return 'London+NY';
  if (m >= 22 * 60 + 30 || m < 1 * 60 + 30) return 'New York';
  return 'Late US';
}

export async function addJournal(userId: string, entry: JournalEntry, now = Date.now()): Promise<{ id: string; halfLeft: number }> {
  await ensureRulebookSchema();
  const at = entry.exitAt ?? now;
  const full: JournalEntry = { ...entry, session: sessionOf(at), weekday: WEEKDAYS[istWeekday(at)] };
  const id = randomUUID();
  await pool.query('INSERT INTO rulebook_journal (id, user_id, at, day_key, entry) VALUES ($1,$2,$3,$4,$5)', [id, userId, new Date(at), istDayKey(at), JSON.stringify(full)]);
  // each finished trade uses up one of the half-size trades
  const s = await getState(userId);
  const halfLeft = Math.max(0, s.halfLeft - 1);
  if (halfLeft !== s.halfLeft) await putState(userId, { halfLeft });
  return { id, halfLeft };
}

export async function journal(userId: string, sinceMs: number) {
  await ensureRulebookSchema();
  const r = await pool.query('SELECT id, at, day_key, entry FROM rulebook_journal WHERE user_id = $1 AND at >= $2 ORDER BY at DESC LIMIT 500', [userId, new Date(sinceMs)]);
  return r.rows.map((x: any) => ({ id: x.id, at: new Date(x.at).getTime(), dayKey: x.day_key, entry: (typeof x.entry === 'string' ? JSON.parse(x.entry) : x.entry) as JournalEntry }));
}

export async function dayStats(userId: string, now = Date.now()) {
  await ensureRulebookSchema();
  const r = await pool.query('SELECT entry FROM rulebook_journal WHERE user_id = $1 AND day_key = $2', [userId, istDayKey(now)]);
  const es = r.rows.map((x: any) => (typeof x.entry === 'string' ? JSON.parse(x.entry) : x.entry) as JournalEntry);
  return {
    ruleExits: es.filter((e) => (RULE_EXITS as readonly string[]).includes(e.exitReason)).length,
    netPnlUsd: es.reduce((s, e) => s + (Number(e.netPnlUsd) || 0), 0),
  };
}

/** Weekly review: win rate, average win vs loss, rule breaks. */
export async function review(userId: string, days = 7, now = Date.now()) {
  const since = now - days * 24 * H;
  const rows = await journal(userId, since);
  const pnl = rows.map((r) => Number(r.entry.netPnlUsd) || 0);
  const wins = pnl.filter((x) => x > 0), losses = pnl.filter((x) => x < 0);
  const breaks = (await recentBreaks(userId, 500)).filter((b) => b.at >= since);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    days, trades: rows.length, winRate: rows.length ? wins.length / rows.length : null,
    avgWin: avg(wins), avgLoss: avg(losses), net: pnl.reduce((a, b) => a + b, 0),
    ruleExits: rows.filter((r) => (RULE_EXITS as readonly string[]).includes(r.entry.exitReason)).length,
    ruleBreaks: breaks.length,
  };
}

// ---------------- live checklist ----------------

const reading = (snap: ReturnType<typeof regimeService.snapshot>, id: string) => snap.inputs.find((x) => x.id === id);

/** Weekend, or a top-tier US release in this IST week (Mon–Sun) → the smaller risk band. */
export function isSmallRiskDay(now: number, releases: { atMs: number }[] | null): boolean {
  const wd = istWeekday(now);
  if (wd === 0 || wd === 6) return true;
  if (!releases) return false;
  const dayStart = Date.parse(`${istDayKey(now)}T00:00:00Z`) - IST;
  const weekStart = dayStart - ((wd + 6) % 7) * 24 * H;
  return releases.some((r) => r.atMs >= weekStart && r.atMs < weekStart + 7 * 24 * H);
}

/** Live top-tier releases, plus the expected NFP (first Friday) for months the weekly feed does not reach. */
export function calendarReleases(live: { title: string; atMs: number }[] | null, now: number): Release[] {
  const out: Release[] = (live ?? []).map((r) => ({ title: r.title, atMs: r.atMs, kind: releaseKind(r.title) }));
  for (let k = 0; k < 3; k++) {
    const { y, m } = istDate(now);
    const mm = ((m - 1 + k) % 12) + 1, yy = y + Math.floor((m - 1 + k) / 12);
    const n = expectedNfp(yy, mm);
    if (!out.some((r) => r.kind === 'NFP' && Math.abs(r.atMs - n.atMs) < 4 * 24 * H)) out.push(n);
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}

export interface LiveChecklist extends ChecklistResult {
  tonight: Tonight;
  vol: VolRead | null;
  asOf: number;
  state: RulebookState;
  expiry: string | null;
  config: typeof CFG;
}

export async function liveChecklist(userId: string, now = Date.now()): Promise<LiveChecklist> {
  const [marketR, eventsR, pulseR, state, day, vol] = await Promise.all([
    loadMarket(false).catch(() => null),
    loadUsEvents(now).catch(() => null),
    pulseNow('n2n').catch(() => null),
    getState(userId),
    dayStats(userId, now),
    volRead(now).catch(() => null),
  ]);

  let legs: LegQuote[] | null = null;
  let expiry: string | null = null;
  let legsReason: string | null = marketR ? null : 'market data unavailable';
  let expiryMs: number | null = null;
  if (marketR) {
    // aim at the middle of the 0.10-0.15 band, so a strike anywhere inside it is used
    const target = (CFG.deltaMin + CFG.deltaMax) / 2;
    const rule = defaultStrangle({ legs: [{ type: 'call', side: 'sell', pick: { mode: 'delta', target } }, { type: 'put', side: 'sell', pick: { mode: 'delta', target } }] });
    const { plan, reason } = buildPlan(rule, marketR, 1, now);
    legsReason = reason;
    if (plan && plan.kind === 'option') {
      const sells = plan.legs.filter((l) => l.side === 'sell');
      if (sells.length === 2) legs = sells.map((l) => ({ type: l.type, strike: l.strike, delta: l.delta, bid: l.bid, ask: l.ask }));
      expiry = plan.expiries[0] ?? null;
      expiryMs = sells[0]?.expiryMs ?? null;
    }
  }

  const snap = regimeService.snapshot(now);
  const ivRv = reading(snap, 'iv_rv'), adx = reading(snap, 'adx'), killer = reading(snap, 'killer');
  const news = newsWatcher.status(now);
  const releases = eventsR ? topTierReleases(eventsR) : null;
  const cal = calendarReleases(releases, now);
  const t = tonight(now, cal, expiryMs ?? undefined);

  const input: ChecklistInput = {
    nowMs: now,
    marketOk: !!marketR && marketR.chain.length > 0 && marketR.spot > 0,
    regimeFresh: !!ivRv?.available,
    newsFeedDown: news.feedDown,
    news: { level: news.level === 'CRITICAL' || news.level === 'HIGH' ? news.level : null, until: news.noNewEntriesUntil },
    releases,
    ivRv: ivRv?.available && typeof ivRv.value === 'number' ? ivRv.value : null,
    adx: adx?.available && typeof adx.value === 'number' ? adx.value : null,
    killer: killer?.available ? killer.ok === false : null,
    pulseZone: pulseR?.zone ?? null,
    legs,
    legsReason,
    equityUsd: state.equityUsd,
    halfSizeLeft: state.halfLeft,
    day: { ...day, unlocked: state.unlockedDay === istDayKey(now) },
    smallRiskDay: isSmallRiskDay(now, releases),
    calendarMult: t.size.product,
    volChecks: volChecks(vol),
    volSizeMult: vol?.gate.sizeMult ?? null,
    // without the live calendar only the expected NFP and the Fed's FOMC dates are known: that is not a clear path
    inPath: releases ? t.inPath : null,
  };
  return { ...evaluateChecklist(input), asOf: now, state, expiry, config: CFG, tonight: t, vol };
}
