/**
 * Turns a plain-English question into an intent plus the things it mentions (strategy, period,
 * clock time, date). Pure and deterministic: no model, no network, so the same question always
 * routes the same way and every answer comes from the desk's own data.
 */
export type Intent =
  | 'help'
  | 'positions'
  | 'pnl'
  | 'explain'
  | 'at_time'
  | 'why_no_trade'
  | 'ranking'
  | 'exit_quality'
  | 'market'
  | 'replay'
  | 'rules'
  | 'events'
  | 'manual_trades'
  | 'nights'
  | 'audit'
  | 'recalibration'
  | 'alerts'
  | 'unknown';

export interface Period {
  from: number;
  to: number;
  label: string;
}

export interface Parsed {
  intent: Intent;
  /** Exact strategy id, e.g. NY_SHORT. */
  strategy?: string;
  /** Prefix for a family of strategies, e.g. FUT_ or a list of ids. */
  group?: { label: string; ids: string[] };
  period?: Period;
  /** HH:MM, 24h, IST. */
  time?: string;
  /** YYYY-MM-DD (IST). */
  dateKey?: string;
  limit?: number;
  raw: string;
}

const IST = 19_800_000;
const DAY = 86_400_000;
const istMidnight = (ms: number) => Math.floor((ms + IST) / DAY) * DAY - IST;
const dateKeyOf = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

export const STRATEGY_NAMES: Record<string, string> = {
  ASIA_SHORT: 'Asia short strangle (10:00 IST)',
  NY_SHORT: 'New York short strangle (22:30 IST)',
  ASIA_IC: 'Asia iron condor, 24h (10:00 IST)',
  NY_IC: 'New York iron condor, 24h (22:30 IST)',
  EVE_LONG: 'Evening long straddle (17:30 IST)',
  PRE_LONG: 'Pre-dawn long straddle (05:00 IST)',
  CAL_BACK: 'Calendar spread in backwardation (18:00 IST)',
  FUT_SWEEP_LDN: 'Futures: London sweeps the Asia range',
  FUT_SWEEP_NY: 'Futures: New York sweeps the London range',
  FUT_SIGNAL: 'Futures: price-action signal',
};

const ALL = Object.keys(STRATEGY_NAMES);

/** Most specific alias first. */
const STRATEGY_ALIASES: Array<[RegExp, string]> = [
  [/\b(asia|10\s*(am|:00)?)\b.*\b(iron\s*condor|condor|ic)\b|\b(iron\s*condor|condor)\b.*\basia\b/, 'ASIA_IC'],
  [/\b(ny|new\s*york|night|22:30|10:30\s*pm)\b.*\b(iron\s*condor|condor|ic)\b|\b(iron\s*condor|condor)\b.*\b(ny|new\s*york)\b/, 'NY_IC'],
  [/\b(london)\b.*\bsweep|london\s*sweep|ldn\s*sweep|fut_sweep_ldn/, 'FUT_SWEEP_LDN'],
  [/\b(ny|new\s*york)\b.*\bsweep|ny\s*sweep|fut_sweep_ny/, 'FUT_SWEEP_NY'],
  [/\bfut_signal|futures?\s*signal|price\s*signal/, 'FUT_SIGNAL'],
  [/\bcalendar|cal_back|backwardation\b/, 'CAL_BACK'],
  [/\b(pre[\s-]*dawn|5\s*am|05:00|pre_long)\b/, 'PRE_LONG'],
  [/\b(evening|17:30|5:30\s*pm|eve_long)\b.*\b(straddle|long)?|\beve_long\b/, 'EVE_LONG'],
  [/\b(asia|10\s*am|10:00|asia_short)\b/, 'ASIA_SHORT'],
  [/\b(ny|new\s*york|22:30|10:30\s*pm|ny_short)\b/, 'NY_SHORT'],
];

const STRATEGY_GROUPS: Array<[RegExp, { label: string; ids: string[] }]> = [
  [/\bfutures?\b/, { label: 'futures strategies', ids: ['FUT_SWEEP_LDN', 'FUT_SWEEP_NY', 'FUT_SIGNAL'] }],
  [/\b(iron\s*condors?|condors?)\b/, { label: 'iron condors', ids: ['ASIA_IC', 'NY_IC'] }],
  [/\bstraddles?\b/, { label: 'long straddles', ids: ['EVE_LONG', 'PRE_LONG'] }],
  [/\b(short\s*strangles?|strangles?)\b/, { label: 'short strangles', ids: ['ASIA_SHORT', 'NY_SHORT'] }],
  [/\boptions?\b/, { label: 'option strategies', ids: ALL.filter((i) => !i.startsWith('FUT_')) }],
];

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function parsePeriod(q: string, nowMs: number): Period | undefined {
  const today = istMidnight(nowMs);
  const dow = new Date(today + IST).getUTCDay();
  const mondayOffset = (dow + 6) % 7;
  const n = (s: string) => Number(s);
  let m: RegExpExecArray | null;
  if (/\byesterday\b/.test(q)) return { from: today - DAY, to: today, label: 'yesterday' };
  if (/\btoday\b|\btonight\b|\bso far\b|\bthis morning\b/.test(q)) return { from: today, to: today + DAY, label: 'today' };
  if (/\blast\s+week\b/.test(q)) return { from: today - (mondayOffset + 7) * DAY, to: today - mondayOffset * DAY, label: 'last week' };
  if (/\bthis\s+week\b|\bweek\b/.test(q)) return { from: today - mondayOffset * DAY, to: today + DAY, label: 'this week' };
  if (/\blast\s+month\b/.test(q)) {
    const d = new Date(today + IST);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) - IST;
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST;
    return { from: start, to: end, label: 'last month' };
  }
  if (/\bthis\s+month\b|\bmonth\b/.test(q)) {
    const d = new Date(today + IST);
    return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST, to: today + DAY, label: 'this month' };
  }
  if ((m = /\b(?:last|past)\s+(\d{1,3})\s*(day|days|d)\b/.exec(q))) return { from: today - (n(m[1]!) - 1) * DAY, to: today + DAY, label: `last ${m[1]} days` };
  if ((m = /\b(?:last|past)\s+(\d{1,2})\s*(week|weeks|w)\b/.exec(q))) return { from: today - n(m[1]!) * 7 * DAY, to: today + DAY, label: `last ${m[1]} weeks` };
  if (/\b(all\s*time|overall|ever|since\s+the\s+start|total)\b/.test(q)) return { from: 0, to: today + DAY, label: 'all time' };
  for (let i = 0; i < 7; i++) {
    if (q.includes(WEEKDAYS[i]!)) {
      const back = (dow - i + 7) % 7 || 7;
      return { from: today - back * DAY, to: today - back * DAY + DAY, label: `last ${WEEKDAYS[i]}` };
    }
  }
  return undefined;
}

/** 24h HH:MM from "10:05", "10.05", "10 am", "10:30pm", "22:30". */
export function parseTime(q: string): string | undefined {
  let m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(q);
  let h: number;
  let min = 0;
  let ap: string | undefined;
  if (m) {
    h = Number(m[1]);
    min = Number(m[2]);
    ap = m[3];
  } else if ((m = /\b(\d{1,2})\s*(am|pm)\b/.exec(q))) {
    h = Number(m[1]);
    ap = m[2];
  } else return undefined;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseDate(q: string, nowMs: number): string | undefined {
  const iso = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(q);
  if (iso) return iso[1];
  if (/\byesterday\b/.test(q)) return dateKeyOf(nowMs - DAY);
  if (/\btoday\b|\btonight\b/.test(q)) return dateKeyOf(nowMs);
  return undefined;
}

export function parseStrategy(q: string): { strategy?: string; group?: { label: string; ids: string[] } } {
  const direct = /\b(asia_short|ny_short|asia_ic|ny_ic|eve_long|pre_long|cal_back|fut_sweep_ldn|fut_sweep_ny|fut_signal)\b/i.exec(q);
  if (direct) return { strategy: direct[1]!.toUpperCase() };
  for (const [re, id] of STRATEGY_ALIASES) if (re.test(q)) return { strategy: id };
  for (const [re, g] of STRATEGY_GROUPS) if (re.test(q)) return { group: g };
  return {};
}

const has = (q: string, re: RegExp) => re.test(q);

export function parseQuestion(raw: string, nowMs: number = Date.now()): Parsed {
  const q = ` ${raw.toLowerCase().replace(/[?!]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const time = parseTime(q);
  const base = { raw, ...parseStrategy(q), period: parsePeriod(q, nowMs), time, dateKey: parseDate(q, nowMs) };
  const limit = (() => {
    const m = /\b(?:top|last|latest|recent)\s+(\d{1,2})\b/.exec(q);
    return m ? Number(m[1]) : undefined;
  })();
  const out = (intent: Intent): Parsed => ({ ...base, intent, limit });

  if (has(q, /\b(help|what can you|what do you|commands|capabilit\w*|how do i ask|examples)\b/)) return out('help');

  const askingAt = time && has(q, /\b(what|happen|happened|saw|see|doing|was|were|state|record|position)\b/);
  if (askingAt && !has(q, /\b(entry|enter|entered)\b.*\b(rule|when)\b/)) return out('at_time');

  if (has(q, /\bwhy\b.*\b(not|no|n't|didn|skip|skipped|wait|waited|blocked|failed|fail)\b.*\b(trade|trad|enter|entry|entered|position|run|take|taken)\b|\bwhy\b.*\b(no trade|skipped|didn.?t trade)\b|\bno trade\b.*\bwhy\b/)) return out('why_no_trade');

  if (has(q, /\b(why|explain|reason|what happened)\b/) && has(q, /\b(stop|stopped|exit|exited|closed|close|loss|lost|lose|loses|losing|win|won|tp|target|hit|breakeven|trail|time exit|kill)\b/)) return out('explain');

  if (has(q, /\b(recalibrat\w*|bonferroni|out of sample|oos|edge decay|decaying|re-?validation)\b/)) return out('recalibration');
  if (has(q, /\b(telemetry|audit|session logs?|mismatch|self.?test)\b/)) return out('audit');
  if (has(q, /\b(nightly|night review|reviews?|verdicts?)\b/)) return out('nights');
  if (has(q, /\b(my trades?|manual trades?|journal|trades table|real trades?|logged trades?)\b/)) return out('manual_trades');
  if (has(q, /\b(alerts?|notifications?|telegram|ntfy)\b/) && !has(q, /\berror/)) return out('alerts');

  if (has(q, /\b(give.?back|peak|best exit|worst exit|exit quality|when (?:was|were|should|to).*exit|exit (?:time|at)|what if.*exit|exited? (?:earlier|later))\b/)) return out('exit_quality');

  if (has(q, /\b(best|worst|top|bottom|which|compare|ranking|rank)\b.*\b(strateg|session|day|weekday|time|book|one|performing|performer)/)) return out('ranking');
  if (has(q, /\b(session|asia|london|ny|new york)\b.*\b(best|worst|good|bad|better|earn|profit)/) && !base.strategy) return out('ranking');

  if (has(q, /\b(rules?|how does|how do you|what is the|what's the|define|definition|logic|works?)\b/) && (base.strategy || base.group || has(q, /\b(strateg|strangle|condor|straddle|calendar|sweep|gate|stop|target)/))) return out('rules');

  if (has(q, /\b(running|open|current|live|active|now)\b.*\b(position|positions|trade|trades|run|runs)\b|\bhow (?:is|are|'s)\b|\bhow'?s\b|\bdoing now\b|\bpnl now\b|\bwhere (?:am|are)\b/)) return out('positions');

  if (has(q, /\b(positions?|holdings?|exposure)\b/)) return out('positions');

  if (has(q, /\b(replay|backtest|back-?test|historical|history|13 months|past year|simulat)/)) return out('replay');

  if (has(q, /\b(error|errors|warning|warnings|problem|problems|events?|logs?|failed|failures?|broken|issue)\b/)) return out('events');

  if (has(q, /\b(will|predict|prediction|forecast|going to|gonna|expect|tomorrow|next week|next month|should i (buy|sell))\b/) && !has(q, /\b(pnl|trade|trades|position|positions|strateg\w*|rule|rules)\b/)) return out('unknown');

  if (has(q, /\b(market|spot|price|btc|dvol|iv|volatility|funding|open interest|oi|macro|stress|vix|gate|go or wait)\b/)) return out('market');

  if (has(q, /\b(pnl|p&l|profit|loss|made|earned|win\s*rate|result|results|performance|summary|how much|stats|statistics|total|fees|stop rate)\b/)) return out('pnl');

  if (base.strategy || base.group) return out('pnl');
  return out('unknown');
}

export const SUGGESTIONS = [
  'Running positions',
  "Today's PnL",
  'This week by strategy',
  'Why was the last trade stopped?',
  'Why no trade today?',
  'Best session',
  'Market now',
  'Recent errors',
  'Replay summary',
  'What is the NY short rule?',
];
