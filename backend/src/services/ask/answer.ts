import { SLOTS } from '../../lib/bot/schedule.js';

import { KNOWLEDGE_MAX_UNKNOWN, KNOWLEDGE_MIN_COVERAGE, KNOWLEDGE_MIN_SCORE, searchKnowledge, type KnowledgeEntry } from '../../lib/ask/knowledge.js';
import { STRATEGY_NAMES, SUGGESTIONS, isForecast, parseQuestion, type Intent, type Parsed } from '../../lib/ask/parse.js';
import { dataOverview, loadCatalog, tableSummary } from './explore.js';

/**
 * Answers a question using ONLY the desk's own data: the Postgres tables (bot runs, fills, minute
 * records, events, manual trades, nightly reviews, audits, alerts, indicator snapshots), the live
 * in-memory market state, and the stored replay results. No model and no network: every number is
 * read from a row or computed from rows, and each answer lists the sources it used.
 */
export interface Answer {
  text: string;
  table?: { head: string[]; rows: Array<Array<string | number>> };
  sources: string[];
  suggestions?: string[];
  intent: Intent;
}

export interface AskContext {
  q(sql: string, params?: unknown[]): Promise<Array<Record<string, any>>>;
  now: number;
  live: {
    botEnabled(): boolean;
    botStatus(): { engine: string; mode: string; lastTickAt: number | null; lastError: string | null };
    positions(): Promise<any[]>;
    market(): { spot: number | null; mark: number | null; funding: number | null; oi: number | null; dvol: number | null; macro: { score: number; zone: string; direction: string; nextEvent: string; tradeRule: string } | null };
    replay(): any | null;
  };
  /** The terminal's written knowledge: glossary plus text from the docs and tooltips. */
  knowledge?: () => KnowledgeEntry[];
}

const IST = 19_800_000;
const DAY = 86_400_000;
const usd = (v: number | null | undefined, d = 2): string => (v == null || !Number.isFinite(v) ? '-' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(d)}`);
const pct = (v: number | null | undefined, d = 0): string => (v == null || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(d)}%`);
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const when = (ms: number | Date | null | undefined): string => {
  if (ms == null) return '-';
  const d = new Date((ms instanceof Date ? ms.getTime() : ms) + IST);
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)} IST`;
};
const istDateKey = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);
const nm = (id: string) => STRATEGY_NAMES[id] ?? id;
const ids = (p: Parsed): string[] | null => (p.strategy ? [p.strategy] : p.group ? p.group.ids : null);
const scopeLabel = (p: Parsed) => (p.strategy ? nm(p.strategy) : p.group ? p.group.label : 'all strategies');

export const RULES_TEXT: Record<string, string> = {
  ASIA_SHORT: 'Sells a call and a put on the N2N expiry at about 0.125 delta (band 0.10-0.15) at 10:00 IST, 100 lots per leg. Exits: take profit at +10% of margin, close everything if either sold leg reaches 2x its entry price, or force-close at 16:00 IST. Runs in two books: "always" and "gated" (only when the GO gate says GO).',
  NY_SHORT: 'Same structure as the Asia short strangle but entered at 22:30 IST. Exits: +10% of margin, 2x stop on either leg (closes both), or force-close at 07:00 IST. Two books: always and gated.',
  ASIA_IC: 'The Asia short strangle plus a bought wing on each side (about 0.04 delta) at 10:00 IST. Runs a full 24 hours with no intraday time exit (leaves next day 10:00); take profit +10% of margin and the 2x stop on the short legs still apply, and one stop closes everything.',
  NY_IC: 'The New York short strangle plus bought wings at 22:30 IST, held 24 hours (exits next day 22:30), +10% of margin target and the 2x stop on the short legs.',
  EVE_LONG: 'Buys the ATM straddle (call and put at the same strike) on the next expiry at 17:30 IST, every day. Exits: +50% of margin, -10% of margin, or time exit about 21:00 IST.',
  PRE_LONG: 'Buys the ATM straddle on the next expiry at 05:00 IST, every day. Exits: +50% of margin, -10% of margin, or time exit at 09:00 IST.',
  CAL_BACK: 'At 18:00 IST, if the current expiry\'s IV is at least 2 points above the N2N expiry\'s (backwardation), sells the current-expiry ATM call and put and buys the same strikes on N2N. Exits only at +10% of margin or when spot leaves the breakeven band computed at entry, with a hard close one hour before the front expiry so the short leg is never left to settle.',
  FUT_SWEEP_LDN: 'BTC perpetual. When London sweeps the Asia high or low (a wick beyond it that closes back inside) and at least 2 of 4 confirmations agree (rejection wick, volume spike, RSI extreme, VWAP side), trades against the sweep. Fixed risk per trade ($5 default), up to 25 lots, stop beyond the sweep extreme, target 2R, breakeven at 1R, trail from 1.5R, 12 hour limit. One trade per session.',
  FUT_SWEEP_NY: 'Same as the London sweep strategy, but New York sweeping the London high or low.',
  FUT_SIGNAL: 'BTC perpetual, any time. Needs 2 agreeing price votes (reclaim of the prior day\'s high/low, a volume breakout beyond it, an RSI extreme) and no opposing vote. Same sizing and exits as the sweeps; at most 3 trades a day with a 4 hour cool-down.',
};

const EXIT_TEXT: Record<string, string> = {
  stop: 'a stop was hit',
  tp: 'the profit target was reached',
  target: 'the profit target was reached',
  sl: 'the loss limit was reached',
  time: 'the scheduled time exit arrived',
  breakeven: 'price moved back to the breakeven stop',
  trail: 'the trailing stop was hit',
  hard_close: 'the safety close before the front expiry fired',
  'kill switch': 'the kill switch flattened everything',
};

async function safe(a: Answer, fn: () => Promise<Answer>): Promise<Answer> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const missing = /relation "([^"]+)" does not exist/.exec(msg);
    return { ...a, text: missing ? `I could not read "${missing[1]}": that table does not exist in the database yet.` : `I hit a database error while looking that up: ${msg}`, sources: [] };
  }
}

// ---------- handlers ----------

async function positions(p: Parsed, c: AskContext): Promise<Answer> {
  const sources = ['live paper positions'];
  if (!c.live.botEnabled()) {
    return { intent: 'positions', sources, text: 'The paper bot is switched off (BOT_ENABLED is not set on the server), so there are no running positions. The Replay tab and my answers about history still work.' };
  }
  let list = await c.live.positions();
  const want = ids(p);
  if (want) list = list.filter((x) => want.includes(x.strategy));
  if (!list.length) return { intent: 'positions', sources, text: `No running ${want ? scopeLabel(p) + ' ' : ''}positions right now. Bot engine: ${c.live.botStatus().engine}.` };
  const total = list.reduce((s, x) => s + (x.pnl?.netPnl ?? 0), 0);
  return {
    intent: 'positions', sources,
    text: `${list.length} running position${list.length > 1 ? 's' : ''}, combined net PnL ${usd(total)} (after entry fees).`,
    table: {
      head: ['Position', 'Net PnL', '% margin', 'Distance to exit', 'Time left'],
      rows: list.map((x) => {
        const fut = x.exit?.kind === 'futures';
        const dist = fut
          ? `target ${usd(Math.abs(x.exit.target - x.spot), 0)} away, stop ${usd(Math.abs(x.spot - x.exit.stop), 0)} away`
          : x.exit?.tpPctOfMargin != null && x.pnl ? `TP needs ${usd(x.exit.tpPctOfMargin * x.marginUsd - x.pnl.netPnl)} more` : '-';
        return [`${nm(x.strategy)}${x.book === 'gated' ? ' (gated)' : ''}`, usd(x.pnl?.netPnl), x.pnl ? pct(x.pnl.pctOfMargin, 1) : '-', dist, x.minutesToTimeExit == null ? '-' : `${(x.minutesToTimeExit / 60).toFixed(1)} h`];
      }),
    },
  };
}

async function pnl(p: Parsed, c: AskContext): Promise<Answer> {
  const per = p.period ?? { from: 0, to: c.now + DAY, label: 'all time' };
  const want = ids(p);
  const rows = await c.q(
    `SELECT strategy, book, COUNT(*)::int AS n, SUM(net_pnl)::float AS net, AVG(net_pnl)::float AS avg,
            AVG((net_pnl > 0)::int)::float AS win, AVG((exit_reason = 'stop')::int)::float AS stop,
            AVG((exit_reason IN ('tp','target'))::int)::float AS tp,
            SUM(COALESCE(fees_entry,0) + COALESCE(fees_exit,0))::float AS fees,
            MIN(net_pnl)::float AS worst, MAX(net_pnl)::float AS best
       FROM bot_runs WHERE status = 'closed' AND exit_at >= to_timestamp($1/1000.0) AND exit_at < to_timestamp($2/1000.0)
        AND ($3::text[] IS NULL OR strategy = ANY($3)) GROUP BY strategy, book ORDER BY strategy, book`,
    [per.from, per.to, want],
  );
  const sources = ['bot_runs'];
  const n = rows.reduce((s, r) => s + r.n, 0);
  const net = rows.reduce((s, r) => s + (r.net ?? 0), 0);
  let text: string;
  if (!n) text = `No closed paper trades for ${scopeLabel(p)} in ${per.label}.`;
  else {
    const wins = rows.reduce((s, r) => s + r.win * r.n, 0) / n;
    const stops = rows.reduce((s, r) => s + r.stop * r.n, 0) / n;
    const fees = rows.reduce((s, r) => s + (r.fees ?? 0), 0);
    text = `Realised paper PnL for ${scopeLabel(p)}, ${per.label}: ${usd(net)} over ${n} closed trade${n > 1 ? 's' : ''} (win rate ${pct(wins)}, stopped ${pct(stops)}, fees ${usd(fees)}).`;
  }
  if (c.live.botEnabled()) {
    let open = await c.live.positions();
    if (want) open = open.filter((x) => want.includes(x.strategy));
    if (open.length) text += ` Plus ${open.length} running with ${usd(open.reduce((s, x) => s + (x.pnl?.netPnl ?? 0), 0))} unrealised.`;
  }
  // manual trades logged on the desk
  try {
    const m = await c.q(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(realized_pnl),0)::float AS pnl FROM trades WHERE status = 'CLOSED' AND exit_time >= to_timestamp($1/1000.0) AND exit_time < to_timestamp($2/1000.0)`,
      [per.from, per.to],
    );
    if (m[0]?.n) {
      text += ` Your manually logged trades in the same period: ${m[0].n} closed, ${usd(m[0].pnl)}.`;
      sources.push('trades');
    }
  } catch { /* the manual trades table is optional */ }
  return {
    intent: 'pnl', sources, text,
    table: rows.length ? { head: ['Strategy', 'Trades', 'Net PnL', 'Avg', 'Win', 'Stop', 'TP', 'Worst', 'Best'], rows: rows.map((r) => [`${nm(r.strategy)}${r.book === 'gated' ? ' (gated)' : ''}`, r.n, usd(r.net), usd(r.avg), pct(r.win), pct(r.stop), pct(r.tp), usd(r.worst), usd(r.best)]) } : undefined,
  };
}

async function explain(p: Parsed, c: AskContext): Promise<Answer> {
  const want = ids(p);
  const runs = await c.q(
    `SELECT * FROM bot_runs WHERE ($1::text[] IS NULL OR strategy = ANY($1)) AND ($2::text IS NULL OR date_key = $2) AND status IN ('open','closed')
      ORDER BY COALESCE(exit_at, entry_at) DESC NULLS LAST LIMIT 1`,
    [want, p.dateKey ?? null],
  );
  const r = runs[0];
  if (!r) return { intent: 'explain', sources: ['bot_runs'], text: `I found no ${want ? scopeLabel(p) + ' ' : ''}trade${p.dateKey ? ' on ' + p.dateKey : ''} to explain.` };
  const [legs, events] = await Promise.all([
    c.q('SELECT * FROM bot_legs WHERE run_id = $1 ORDER BY id', [r.id]),
    c.q('SELECT type, message, at FROM bot_events WHERE run_id = $1 ORDER BY at', [r.id]),
  ]);
  const net = num(r.net_pnl);
  const peak = num(r.peak_pnl);
  const fees = (num(r.fees_entry) ?? 0) + (num(r.fees_exit) ?? 0);
  const lines: string[] = [];
  lines.push(`${nm(r.strategy)}${r.book === 'gated' ? ' (gated book)' : ''}, run ${r.date_key}, ${r.mode} mode.`);
  lines.push(`Entered ${when(r.entry_at)}: ${legs.map((l) => `${l.side} ${l.lots} ${l.type === 'future' ? 'lots BTCUSD' : `${l.type} ${Number(l.strike)}`} @ ${Number(l.entry_price).toFixed(1)}`).join(', ')}. Margin ${usd(num(r.margin_usd))}.`);
  const tags = r.tags ?? {};
  if (tags.signal?.note) lines.push(`Why it entered: ${tags.signal.note}.`);
  if (tags.gate) lines.push(`Gate at entry: ${tags.gate.go ? 'GO' : 'WAIT'}${tags.gate.reasons?.length ? ` (${tags.gate.reasons.join('; ')})` : ''}, DVOL ${tags.gate.dvol == null ? 'n/a' : Number(tags.gate.dvol).toFixed(1)}, macro ${tags.gate.macroZone}.`);
  if (r.status === 'closed') {
    lines.push(`Closed ${when(r.exit_at)} because ${EXIT_TEXT[r.exit_reason] ?? r.exit_reason}${r.exit_detail ? ` (${r.exit_detail})` : ''}.`);
    lines.push(`Result: net ${usd(net)} after ${usd(fees)} of fees; best it reached ${usd(peak)}${peak != null && net != null ? `, so it gave back ${usd(Math.max(peak - net, 0))} from the peak` : ''}; worst ${usd(num(r.trough_pnl))}.`);
  } else lines.push('It is still open.');
  const slips = await c.q('SELECT SUM(ABS(avg_price - intended_price) * filled * 0.001)::float AS s FROM bot_fills WHERE run_id = $1', [r.id]);
  if (slips[0]?.s) lines.push(`Fill slippage versus the quoted price: about ${usd(slips[0].s)}.`);
  return {
    intent: 'explain', sources: ['bot_runs', 'bot_legs', 'bot_fills', 'bot_events'], text: lines.join('\n'),
    table: events.length ? { head: ['When', 'Event', 'Detail'], rows: events.slice(0, 8).map((e) => [when(e.at), e.type, String(e.message).slice(0, 120)]) } : undefined,
  };
}

async function atTime(p: Parsed, c: AskContext): Promise<Answer> {
  const day = p.dateKey ?? istDateKey(c.now);
  const [hh, mm] = (p.time ?? '00:00').split(':').map(Number);
  const minuteMs = Date.parse(`${day}T00:00:00Z`) - IST + ((hh ?? 0) * 60 + (mm ?? 0)) * 60_000;
  const [marks, ctx, events] = await Promise.all([
    c.q(`SELECT mm.net_pnl, mm.pct_margin, mm.spot, mm.snapshot, r.strategy, r.book FROM bot_minute_marks mm JOIN bot_runs r ON r.id = mm.run_id WHERE mm.minute_ms = $1`, [minuteMs]),
    c.q('SELECT spot, ctx FROM bot_minute_context WHERE minute_ms = $1', [minuteMs]),
    c.q(`SELECT type, message FROM bot_events WHERE at >= to_timestamp($1/1000.0) AND at < to_timestamp(($1+60000)/1000.0) ORDER BY at`, [minuteMs]),
  ]);
  const lines = [`At ${p.time} IST on ${day}:`];
  if (marks.length) for (const m of marks) lines.push(`- ${nm(m.strategy)}${m.book === 'gated' ? ' (gated)' : ''}: net ${usd(num(m.net_pnl))} (${pct(num(m.pct_margin), 1)} of margin), spot ${Math.round(Number(m.spot))}`);
  else lines.push('- no position was recorded as open at that minute.');
  const x = ctx[0]?.ctx;
  if (x) lines.push(`Market: spot ${Math.round(Number(ctx[0]!.spot))}; gate ${x.gate ? (x.gate.go ? 'GO' : `WAIT (${(x.gate.reasons ?? []).join('; ')})`) : 'n/a'}; DVOL ${x.gate?.dvol == null ? 'n/a' : Number(x.gate.dvol).toFixed(1)}; macro ${x.gate?.macroZone ?? 'n/a'}.`);
  else lines.push('No market context was recorded for that minute (the bot was off, or the minute is in the future).');
  for (const e of events) lines.push(`Event: ${e.type}: ${String(e.message).slice(0, 140)}`);
  return { intent: 'at_time', sources: ['bot_minute_marks', 'bot_minute_context', 'bot_events'], text: lines.join('\n') };
}

async function whyNoTrade(p: Parsed, c: AskContext): Promise<Answer> {
  const day = p.dateKey ?? istDateKey(c.now);
  const want = ids(p);
  const runs = await c.q(`SELECT strategy, book, status, tags FROM bot_runs WHERE date_key = $1 AND ($2::text[] IS NULL OR strategy = ANY($2)) ORDER BY strategy, book`, [day, want]);
  const dayStart = Date.parse(`${day}T00:00:00Z`) - IST;
  const events = await c.q(
    `SELECT strategy, type, message, at FROM bot_events WHERE type IN ('entry_skipped','entry_failed','entry_blocked') AND at >= to_timestamp($1/1000.0) AND at < to_timestamp($2/1000.0)
       AND ($3::text[] IS NULL OR strategy = ANY($3)) ORDER BY at`,
    [dayStart, dayStart + DAY, want],
  );
  const traded = runs.filter((r) => r.status === 'open' || r.status === 'closed');
  const notTraded = runs.filter((r) => r.status === 'skipped' || r.status === 'failed');
  const lines: string[] = [];
  if (traded.length) lines.push(`Traded on ${day}: ${traded.map((r) => `${nm(r.strategy)}${r.book === 'gated' ? ' (gated)' : ''}`).join(', ')}.`);
  if (notTraded.length) {
    lines.push(`Did not trade on ${day}:`);
    for (const r of notTraded) lines.push(`- ${nm(r.strategy)}${r.book === 'gated' ? ' (gated)' : ''}: ${r.status}${r.tags?.reason ? `, ${r.tags.reason}` : r.tags?.gate && !r.tags.gate.go ? `, gate WAIT (${(r.tags.gate.reasons ?? []).join('; ')})` : ''}`);
  }
  if (!runs.length) {
    lines.push(c.live.botEnabled() ? `The bot recorded no runs for ${day}.` : 'The paper bot is switched off, so nothing was entered or recorded.');
    lines.push('Entry times (IST): ' + [...Object.entries(SLOTS).map(([k, v]) => `${k} ${String(Math.floor(v.entryMin / 60)).padStart(2, '0')}:${String(v.entryMin % 60).padStart(2, '0')}`), 'CAL_BACK 18:00', 'futures: when a sweep or signal appears'].join(', ') + '.');
  }
  return {
    intent: 'why_no_trade', sources: ['bot_runs', 'bot_events'], text: lines.join('\n'),
    table: events.length ? { head: ['When', 'Strategy', 'Reason'], rows: events.slice(-8).map((e) => [when(e.at), nm(String(e.strategy ?? '')), String(e.message).slice(0, 140)]) } : undefined,
  };
}

const SESSION_OF: Record<string, string> = { ASIA_SHORT: 'Asia', ASIA_IC: 'Asia', NY_SHORT: 'New York', NY_IC: 'New York', EVE_LONG: 'Evening (pre-NY)', PRE_LONG: 'Pre-dawn', CAL_BACK: 'Evening (calendar)', FUT_SWEEP_LDN: 'London', FUT_SWEEP_NY: 'New York', FUT_SIGNAL: 'Any time' };
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function ranking(p: Parsed, c: AskContext): Promise<Answer> {
  const per = p.period ?? { from: 0, to: c.now + DAY, label: 'all time' };
  const want = ids(p);
  const rows = await c.q(
    `SELECT strategy, book, entry_at, net_pnl::float AS net FROM bot_runs WHERE status = 'closed' AND exit_at >= to_timestamp($1/1000.0) AND exit_at < to_timestamp($2/1000.0) AND ($3::text[] IS NULL OR strategy = ANY($3))`,
    [per.from, per.to, want],
  );
  const lines: string[] = [];
  const tables: Array<NonNullable<Answer['table']>> = [];
  const sources = ['bot_runs'];
  const group = (key: (r: any) => string) => {
    const m = new Map<string, { n: number; sum: number; wins: number }>();
    for (const r of rows) {
      const g = m.get(key(r)) ?? m.set(key(r), { n: 0, sum: 0, wins: 0 }).get(key(r))!;
      g.n++; g.sum += r.net; g.wins += r.net > 0 ? 1 : 0;
    }
    return [...m.entries()].map(([k, g]) => ({ key: k, ...g, avg: g.sum / g.n })).sort((a, b) => b.avg - a.avg);
  };
  if (rows.length >= 5) {
    const bySess = group((r) => SESSION_OF[r.strategy] ?? r.strategy);
    const bySt = group((r) => `${nm(r.strategy)}${r.book === 'gated' ? ' (gated)' : ''}`);
    const byDay = group((r) => WEEKDAY[new Date(new Date(r.entry_at).getTime() + IST).getUTCDay()]!);
    lines.push(`Live paper results, ${per.label} (${rows.length} closed trades). Best session by average PnL per trade: ${bySess[0]!.key} (${usd(bySess[0]!.avg)}); worst: ${bySess[bySess.length - 1]!.key} (${usd(bySess[bySess.length - 1]!.avg)}).`);
    tables.push({ head: ['Session', 'Trades', 'Avg / trade', 'Total', 'Win'], rows: bySess.map((g) => [g.key, g.n, usd(g.avg), usd(g.sum), pct(g.wins / g.n)]) });
    tables.push({ head: ['Strategy', 'Trades', 'Avg / trade', 'Total', 'Win'], rows: bySt.map((g) => [g.key, g.n, usd(g.avg), usd(g.sum), pct(g.wins / g.n)]) });
    tables.push({ head: ['Weekday', 'Trades', 'Avg / trade', 'Total', 'Win'], rows: byDay.map((g) => [g.key, g.n, usd(g.avg), usd(g.sum), pct(g.wins / g.n)]) });
  } else lines.push(`Only ${rows.length} closed live paper trade${rows.length === 1 ? '' : 's'} so far, too few to rank. Rankings need at least 5.`);
  const rep = c.live.replay();
  if (rep?.runs?.length) {
    const sess = new Map<string, { n: number; sum: number }>();
    for (const r of rep.runs) {
      if (want && !want.includes(r.strategy)) continue;
      const s = SESSION_OF[r.strategy] ?? r.strategy;
      const g = sess.get(s) ?? sess.set(s, { n: 0, sum: 0 }).get(s)!;
      g.n++; g.sum += r.netPnl;
    }
    const arr = [...sess.entries()].map(([k, g]) => ({ k, ...g, avg: g.sum / g.n })).sort((a, b) => b.avg - a.avg);
    if (arr.length) {
      lines.push(`Replay (${rep.range.from} to ${rep.range.to}): best session by average PnL per trade is ${arr[0]!.k} (${usd(arr[0]!.avg)}), worst is ${arr[arr.length - 1]!.k} (${usd(arr[arr.length - 1]!.avg)}). Every strategy was negative in that replay, so "best" means "loses least".`);
      tables.push({ head: ['Session (replay)', 'Trades', 'Avg / trade', 'Total'], rows: arr.map((g) => [g.k, g.n, usd(g.avg), usd(g.sum)]) });
      sources.push('replay results');
    }
  }
  return { intent: 'ranking', sources, text: lines.join('\n'), table: tables[0] ? mergeTables(tables) : undefined };
}

/** The chat shows one table; concatenate several with a blank spacer row between them. */
function mergeTables(ts: Array<NonNullable<Answer['table']>>): NonNullable<Answer['table']> {
  const width = Math.max(...ts.map((t) => t.head.length));
  const pad = (r: Array<string | number>) => [...r, ...Array(width - r.length).fill('')];
  const rows: Array<Array<string | number>> = [];
  ts.forEach((t, i) => {
    if (i) rows.push(Array(width).fill(''));
    rows.push(pad(t.head.map((h) => `${h}`)));
    rows.push(...t.rows.map(pad));
  });
  return { head: ts[0]!.head.length === width ? ts[0]!.head : pad(ts[0]!.head) as string[], rows: rows.slice(1) };
}

async function exitQuality(p: Parsed, c: AskContext): Promise<Answer> {
  const want = ids(p);
  const rows = await c.q(
    `SELECT strategy, book, COUNT(*)::int AS n, AVG(net_pnl)::float AS net, AVG(COALESCE(peak_pnl, net_pnl))::float AS peak,
            AVG(GREATEST(COALESCE(peak_pnl, net_pnl) - net_pnl, 0))::float AS giveback
       FROM bot_runs WHERE status = 'closed' AND ($1::text[] IS NULL OR strategy = ANY($1)) GROUP BY strategy, book ORDER BY strategy, book`,
    [want],
  );
  const lines: string[] = [];
  const sources = ['bot_runs'];
  if (rows.length) lines.push('Live paper trades: on average each trade reached its peak, then finished lower by the "gave back" amount below.');
  else lines.push('No closed live paper trades yet, so there is no live exit analysis.');
  const rep = c.live.replay();
  const grid = (rep?.analytics?.exitGrid ?? []).filter((g: any) => !want || want.includes(g.strategy));
  let table: Answer['table'];
  if (rows.length) table = { head: ['Strategy', 'Trades', 'Avg final', 'Avg peak', 'Avg gave back'], rows: rows.map((r) => [`${nm(r.strategy)}${r.book === 'gated' ? ' (gated)' : ''}`, r.n, usd(r.net), usd(r.peak), usd(r.giveback)]) };
  if (grid.length) {
    sources.push('replay results');
    const best = grid.map((g: any) => {
      const top = [...g.points].sort((a: any, b: any) => b.avgPnl - a.avgPnl)[0];
      return { name: `${nm(g.strategy)}${g.book === 'gated' ? ' (gated)' : ''}`, actual: g.actual, offset: top.offsetMin, avg: top.avgPnl };
    });
    lines.push('Replay what-if: if every trade had been closed at one fixed time after entry, the best fixed time versus the real rule was:');
    const t2 = { head: ['Strategy', 'Real rule avg', 'Best fixed exit', 'Avg at that exit'], rows: best.map((b: any) => [b.name, usd(b.actual), b.offset >= 60 ? `${b.offset / 60} h after entry` : `${b.offset} min after entry`, usd(b.avg)]) };
    table = table ? mergeTables([table, t2]) : t2;
  }
  return { intent: 'exit_quality', sources, text: lines.join('\n'), table };
}

async function market(_p: Parsed, c: AskContext): Promise<Answer> {
  const m = c.live.market();
  const lines: string[] = [];
  const sources = ['live market feeds'];
  lines.push(`BTC spot ${m.spot == null ? 'n/a' : Math.round(m.spot)}${m.mark != null ? `, perpetual mark ${Math.round(m.mark)}` : ''}${m.funding != null ? `, funding ${(m.funding * 100).toFixed(4)}%` : ''}${m.oi != null ? `, open interest ${Math.round(m.oi).toLocaleString('en-US')}` : ''}.`);
  lines.push(`Deribit DVOL ${m.dvol == null ? 'n/a' : m.dvol.toFixed(1)}${m.dvol != null ? (m.dvol >= 65 ? ' (above the 65 gate limit)' : ' (below the 65 gate limit)') : ''}.`);
  if (m.macro) lines.push(`Outside-markets stress ${m.macro.score}/100, zone ${m.macro.zone}, ${m.macro.direction}. Next event: ${m.macro.nextEvent}. Desk rule: ${m.macro.tradeRule}`);
  try {
    const s = await c.q(`SELECT recorded_at, atm_iv, n2n_iv, term_current_n2n, term_next_n2n, skew_25d FROM indicator_snapshots ORDER BY recorded_at DESC LIMIT 1`);
    if (s[0]) {
      sources.push('indicator_snapshots');
      lines.push(`Last stored indicator snapshot (${when(s[0].recorded_at)}): ATM IV ${num(s[0].atm_iv)?.toFixed(1) ?? 'n/a'}, N2N IV ${num(s[0].n2n_iv)?.toFixed(1) ?? 'n/a'}, term current-N2N ${num(s[0].term_current_n2n)?.toFixed(2) ?? 'n/a'}, next-N2N ${num(s[0].term_next_n2n)?.toFixed(2) ?? 'n/a'}.`);
    }
  } catch { /* optional */ }
  try {
    const g = await c.q('SELECT minute_ms, ctx FROM bot_minute_context ORDER BY minute_ms DESC LIMIT 1');
    if (g[0]?.ctx?.gate) {
      sources.push('bot_minute_context');
      lines.push(`The bot's gate at ${when(Number(g[0].minute_ms))}: ${g[0].ctx.gate.go ? 'GO' : `WAIT (${(g[0].ctx.gate.reasons ?? []).join('; ')})`}.`);
    }
  } catch { /* optional */ }
  return { intent: 'market', sources, text: lines.join('\n') };
}

async function replay(p: Parsed, c: AskContext): Promise<Answer> {
  const rep = c.live.replay();
  if (!rep) return { intent: 'replay', sources: [], text: 'The replay results file is not available on this server. Generate it with: npx tsx src/scripts/bot-replay.ts' };
  const want = ids(p);
  const rows = (rep.analytics.byStrategy as any[]).filter((g) => !want || want.includes(g.key.split('|')[0]));
  const lines = [
    `Replay ${rep.range.from} to ${rep.range.to} (${rep.range.days} days), ${rep.trials} strategy/book variants. Method: ${rep.method}`,
    rows.length ? `Best of ${scopeLabel(p)} by net PnL: ${nm(rows.slice().sort((a, b) => b.netPnl - a.netPnl)[0].key.split('|')[0])}: ${usd(rows.slice().sort((a, b) => b.netPnl - a.netPnl)[0].netPnl, 0)}. ${rows.every((g) => g.netPnl < 0) ? 'All of them lost money after fees and spread.' : ''}` : 'Nothing matched.',
    'Caveats: option prices are modelled from spot and one ATM IV per expiry (no skew), one market regime, and many variants were tested together, so treat results as a reason to be careful, not proof.',
  ];
  return {
    intent: 'replay', sources: ['replay results'], text: lines.join('\n'),
    table: { head: ['Strategy', 'Trades', 'Net PnL', 'Avg', 'Win', 'Stop', 'Max DD'], rows: rows.map((g) => [nm(g.key.split('|')[0]) + (g.key.endsWith('gated') ? ' (gated)' : ''), g.trades, usd(g.netPnl, 0), usd(g.avgPnl), pct(g.winRate), pct(g.stopRate), usd(-g.maxDrawdown, 0)]) },
  };
}

function rules(p: Parsed): Answer {
  const list = p.strategy ? [p.strategy] : p.group ? p.group.ids : Object.keys(RULES_TEXT);
  return {
    intent: 'rules', sources: ['strategy definitions'],
    text: list.map((id) => `${nm(id)}: ${RULES_TEXT[id]}`).join('\n\n') + (p.strategy || p.group ? '' : '\n\nAll option trades use 100 lots per leg; futures risk a fixed amount per trade with at most 25 lots. Everything is paper trading: no real orders.'),
  };
}

async function events(p: Parsed, c: AskContext): Promise<Answer> {
  const lim = Math.min(p.limit ?? 12, 40);
  const onlyProblems = !/\bevents?\b/i.test(p.raw);
  const rows = await c.q(
    `SELECT at, severity, type, strategy, message FROM bot_events WHERE ($1::bool IS FALSE OR severity IN ('warn','error')) ORDER BY at DESC LIMIT $2`,
    [onlyProblems, lim],
  );
  const st = c.live.botStatus();
  const lines = [`Bot engine: ${c.live.botEnabled() ? st.engine : 'off'}${st.lastError ? `; last error: ${st.lastError}` : ''}.`, rows.length ? `${rows.length} most recent ${onlyProblems ? 'warnings and errors' : 'events'}:` : `No ${onlyProblems ? 'warnings or errors' : 'events'} recorded.`];
  return { intent: 'events', sources: ['bot_events'], text: lines.join('\n'), table: rows.length ? { head: ['When', 'Level', 'Type', 'Detail'], rows: rows.map((e) => [when(e.at), e.severity, e.type, String(e.message).slice(0, 130)]) } : undefined };
}

async function manualTrades(p: Parsed, c: AskContext): Promise<Answer> {
  const per = p.period ?? { from: 0, to: c.now + DAY, label: 'all time' };
  const rows = await c.q(
    `SELECT strategy, status, expiry_date, call_strike, put_strike, entry_time, exit_time, realized_pnl, exit_reason FROM trades
      WHERE entry_time >= to_timestamp($1/1000.0) AND entry_time < to_timestamp($2/1000.0) ORDER BY entry_time DESC LIMIT 200`,
    [per.from, per.to],
  );
  if (!rows.length) return { intent: 'manual_trades', sources: ['trades'], text: `No manually logged trades in the database for ${per.label}.` };
  const closed = rows.filter((r) => r.status === 'CLOSED');
  const total = closed.reduce((s, r) => s + (num(r.realized_pnl) ?? 0), 0);
  const wins = closed.filter((r) => (num(r.realized_pnl) ?? 0) > 0).length;
  return {
    intent: 'manual_trades', sources: ['trades'],
    text: `${rows.length} logged trade${rows.length > 1 ? 's' : ''} (${per.label}): ${closed.length} closed, ${rows.length - closed.length} not closed. Realised ${usd(total)}, win rate ${closed.length ? pct(wins / closed.length) : 'n/a'}.`,
    table: { head: ['Entered', 'Strategy', 'Strikes (P / C)', 'Status', 'PnL', 'Exit'], rows: rows.slice(0, p.limit ?? 8).map((r) => [when(r.entry_time), r.strategy, `${Number(r.put_strike)} / ${Number(r.call_strike)}`, r.status, usd(num(r.realized_pnl)), r.exit_reason ?? '']) },
  };
}

async function nights(p: Parsed, c: AskContext): Promise<Answer> {
  const rows = await c.q(`SELECT session_date, verdict, outcome, iv_1730, iv_ny_open, iv_exit, speed_vs_iv, adx_trend, exit_hour, notes FROM nightly_reviews ORDER BY session_date DESC LIMIT $1`, [p.limit ?? 8]);
  if (!rows.length) return { intent: 'nights', sources: ['nightly_reviews'], text: 'There are no nightly reviews stored yet.' };
  const done = rows.filter((r) => r.outcome);
  return {
    intent: 'nights', sources: ['nightly_reviews'],
    text: `Latest ${rows.length} nightly reviews${done.length ? `: ${done.filter((r) => r.outcome === 'PROFIT').length} profit, ${done.filter((r) => r.outcome === 'LOSS').length} loss` : ''}.`,
    table: { head: ['Date', 'Verdict', 'Outcome', 'IV 17:30', 'IV NY open', 'Speed/IV', 'ADX', 'Notes'], rows: rows.map((r) => [String(r.session_date).slice(0, 10), r.verdict, r.outcome ?? '', num(r.iv_1730) ?? '', num(r.iv_ny_open) ?? '', num(r.speed_vs_iv) ?? '', r.adx_trend ?? '', String(r.notes ?? '').slice(0, 60)]) },
  };
}

async function audit(p: Parsed, c: AskContext): Promise<Answer> {
  const s = await c.q(`SELECT session_status, outcome, COUNT(*)::int AS n, SUM((NOT telemetry_match)::int)::int AS mismatches FROM session_audit_logs GROUP BY session_status, outcome ORDER BY session_status, outcome`);
  if (!s.length) return { intent: 'audit', sources: ['session_audit_logs'], text: 'The session audit log is empty.' };
  const total = s.reduce((x, r) => x + r.n, 0);
  const mism = s.reduce((x, r) => x + (r.mismatches ?? 0), 0);
  const last = await c.q(`SELECT session_date, day_name, session_status, outcome, mismatch_reason FROM session_audit_logs ORDER BY session_date DESC LIMIT $1`, [p.limit ?? 5]);
  return {
    intent: 'audit', sources: ['session_audit_logs'],
    text: `${total} audited sessions; the on-screen state disagreed with the locked rule in ${mism} of them.`,
    table: { head: ['Date', 'Day', 'Status', 'Outcome', 'Mismatch'], rows: last.map((r) => [String(r.session_date).slice(0, 10), r.day_name, r.session_status, r.outcome, r.mismatch_reason ?? '']) },
  };
}

async function recalibration(_p: Parsed, c: AskContext): Promise<Answer> {
  const r = (await c.q(`SELECT run_at, total_sessions, in_sample_sessions, out_of_sample_sessions, cleared_bonferroni, oos_stability_verdict, combo_stop_rate, oos_stop_rate, combo_p_value FROM recalibration_audits ORDER BY run_at DESC LIMIT 1`))[0];
  if (!r) return { intent: 'recalibration', sources: ['recalibration_audits'], text: 'No recalibration audit has run yet.' };
  return {
    intent: 'recalibration', sources: ['recalibration_audits'],
    text: `Last recalibration ${when(r.run_at)}: ${r.total_sessions} sessions (${r.in_sample_sessions} in-sample, ${r.out_of_sample_sessions} out-of-sample). The edge ${r.cleared_bonferroni ? 'cleared' : 'did NOT clear'} the Bonferroni bar (p ${num(r.combo_p_value)?.toFixed(4) ?? 'n/a'}). Combined stop rate ${num(r.combo_stop_rate) ?? 'n/a'}%, out-of-sample ${num(r.oos_stop_rate) ?? 'n/a'}%. Verdict: ${r.oos_stability_verdict}.`,
  };
}

async function alerts(p: Parsed, c: AskContext): Promise<Answer> {
  const rows = await c.q(`SELECT delivered_at, channel, status, title, message FROM alert_logs ORDER BY delivered_at DESC LIMIT $1`, [p.limit ?? 8]);
  if (!rows.length) return { intent: 'alerts', sources: ['alert_logs'], text: 'No alerts have been sent yet.' };
  return {
    intent: 'alerts', sources: ['alert_logs'], text: `${rows.length} most recent alerts.`,
    table: { head: ['When', 'Channel', 'Status', 'Title', 'Message'], rows: rows.map((r) => [when(r.delivered_at), r.channel, r.status, r.title, String(r.message).slice(0, 90)]) },
  };
}

/** Terms whose answer is better with the number right now. */
function liveLine(entryId: string, c: AskContext): string | null {
  const m = c.live.market();
  const map: Record<string, string | null> = {
    'glossary:dvol': m.dvol == null ? null : `Right now DVOL is ${m.dvol.toFixed(1)}${m.dvol >= 65 ? ' (above the 65 gate limit)' : ' (below the 65 gate limit)'}.`,
    'glossary:funding': m.funding == null ? null : `Right now the BTC perpetual funding rate is ${(m.funding * 100).toFixed(4)}%.`,
    'glossary:oi': m.oi == null ? null : `Right now perpetual open interest is ${Math.round(m.oi).toLocaleString('en-US')}.`,
    'glossary:macro': m.macro ? `Right now the stress score is ${m.macro.score}/100, zone ${m.macro.zone}, ${m.macro.direction}.` : null,
  };
  return map[entryId] ?? null;
}

function knowledgeAnswer(question: string, c: AskContext, intent: Intent): Answer | null {
  if (isForecast(question)) return null; // a forecast is never answered from a glossary entry that happens to share a word
  const entries = c.knowledge?.() ?? [];
  const hits = searchKnowledge(question, entries, 4);
  // the best answer is the highest-scoring entry that also covers most of the question
  const usable = hits.filter((h) => h.score >= KNOWLEDGE_MIN_SCORE && h.coverage >= KNOWLEDGE_MIN_COVERAGE && h.unknownShare <= KNOWLEDGE_MAX_UNKNOWN);
  const best = usable[0];
  if (!best) return null;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);
  const lines = [`${best.entry.title}`, clip(best.entry.text, best.entry.source === 'glossary' ? 1500 : 900)];
  const live = liveLine(best.entry.id, c);
  if (live) lines.push(live);
  const related = hits.filter((h) => h !== best).filter((h) => h.score >= KNOWLEDGE_MIN_SCORE * 0.6).slice(0, 2);
  if (related.length) lines.push(`Related: ${related.map((h) => `${h.entry.title}${h.entry.source === 'glossary' ? '' : ` (${h.entry.source})`}`).join('; ')}. Ask me about any of them.`);
  return { intent, sources: [best.entry.source === 'glossary' ? 'terminal glossary' : `doc: ${best.entry.source}`], text: lines.join('\n\n') };
}

function help(): Answer {
  return {
    intent: 'help', sources: [],
    text: [
      'I answer from your own data only: the database, the live market feeds and the stored replay. I never guess; if something is not recorded I will say so. Ask me things like:',
      '- Running positions / how is the NY short doing',
      "- Today's PnL, this week by strategy, last 30 days of the Asia condor",
      '- Why was the last trade stopped? / Why no trade today?',
      '- What was happening at 10:05 (or 22:30 yesterday)?',
      '- Which session is best? / How much did it give back from the peak? / best exit time',
      '- Market now (spot, DVOL, funding, macro)',
      '- Replay summary / replay of the futures',
      '- What is the calendar spread rule?',
      '- Recent errors, last alerts, my manual trades, nightly reviews, recalibration, audit',
      '- What data do you have? / summarise bot runs / describe indicator snapshots last 7 days (any table in the database)',
      '- What is Risk-ADX? / explain N2N / difference between contango and backwardation (concepts from the terminal and its docs)',
    ].join('\n'),
    suggestions: SUGGESTIONS,
  };
}

/**
 * If the question names a table that really exists in the database (any table, including ones added
 * later), treat it as a request to profile that table. The name comes from the catalog, never the text.
 */
async function tableNamedInQuestion(question: string, c: AskContext): Promise<string | null> {
  try {
    const q = ` ${question.toLowerCase().replace(/[^a-z0-9_ ]/g, ' ').replace(/\s+/g, ' ')} `;
    const cat = await loadCatalog(c);
    for (const name of cat.tables.keys()) {
      if (q.includes(` ${name} `) || q.includes(` ${name.replace(/_/g, ' ')} `)) return name;
    }
  } catch { /* no catalog available */ }
  return null;
}

export async function answer(question: string, c: AskContext): Promise<Answer> {
  let p = parseQuestion(question, c.now);
  if ((p.intent === 'unknown' || p.intent === 'concept') && !p.table && !isForecast(question)) {
    const named = await tableNamedInQuestion(question, c);
    if (named) p = { ...p, intent: 'table_summary', table: named };
  }
  const base: Answer = { intent: p.intent, text: '', sources: [] };
  switch (p.intent) {
    case 'help': return help();
    case 'data_overview': return safe(base, async () => ({ intent: 'data_overview' as Intent, ...(await dataOverview(c)) }));
    case 'table_summary': return safe(base, async () => ({ intent: 'table_summary' as Intent, ...(await tableSummary(p, c)) }));
    case 'concept': {
      const k = knowledgeAnswer(question, c, 'concept');
      if (k) return k;
      // a concept-shaped question about a live number ("what is the price") is a market question
      if (/\b(price|spot|btc|funding|dvol|open interest)\b/i.test(question)) return safe(base, () => market(p, c));
      return notFound();
    }
    case 'rules': {
      if (!p.strategy && !p.group) {
        const k = knowledgeAnswer(question, c, 'rules');
        if (k) return k;
      }
      return rules(p);
    }
    case 'market': return safe(base, () => market(p, c));
    case 'replay': return safe(base, () => replay(p, c));
    case 'positions': return safe(base, () => positions(p, c));
    case 'pnl': return safe(base, () => pnl(p, c));
    case 'explain': return safe(base, () => explain(p, c));
    case 'at_time': return safe(base, () => atTime(p, c));
    case 'why_no_trade': return safe(base, () => whyNoTrade(p, c));
    case 'ranking': return safe(base, () => ranking(p, c));
    case 'exit_quality': return safe(base, () => exitQuality(p, c));
    case 'events': return safe(base, () => events(p, c));
    case 'manual_trades': return safe(base, () => manualTrades(p, c));
    case 'nights': return safe(base, () => nights(p, c));
    case 'audit': return safe(base, () => audit(p, c));
    case 'recalibration': return safe(base, () => recalibration(p, c));
    case 'alerts': return safe(base, () => alerts(p, c));
    default: {
      // not one of the data intents: the written knowledge may still know the term
      const k = knowledgeAnswer(question, c, 'concept');
      if (k) return k;
      return notFound();
    }
  }
}

function notFound(): Answer {
  return {
        intent: 'unknown', sources: [],
        text: "I could not match that to something I know. I answer from your own data (any table in the database, the live market, the replay results) and from the terminal's glossary and docs. I only report what was recorded: I do not predict prices or tell you what to trade. Try one of these, or ask \"what data do you have?\":",
        suggestions: SUGGESTIONS,
  };
}

