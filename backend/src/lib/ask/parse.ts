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
  | 'concept'
  | 'data_overview'
  | 'table_summary'
  | 'learning'
  | 'paper'
  | 'teach'
  | 'forget'
  | 'notes'
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
  /** A database table the question refers to (a hint; validated against the catalog later). */
  table?: string;
  /** HH:MM, 24h, IST. */
  time?: string;
  /** YYYY-MM-DD (IST). */
  dateKey?: string;
  limit?: number;
  /** For a "teach" request: the question and answer to store. */
  note?: { q: string; a: string };
  /** For a "forget" request: which note. */
  noteId?: number;
  raw: string;
}

const IST = 19_800_000;
const DAY = 86_400_000;
const istMidnight = (ms: number) => Math.floor((ms + IST) / DAY) * DAY - IST;
const dateKeyOf = (ms: number) => new Date(ms + IST).toISOString().slice(0, 10);

export const STRATEGY_NAMES: Record<string, string> = {
  ASIA_SHORT: 'Asia short strangle (10:00 IST)',
  NY_SHORT: 'New York short strangle (22:30 IST)',
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
  [/\b(london)\b.*\bsweep|london\s*sweep|ldn\s*sweep|fut_sweep_ldn/, 'FUT_SWEEP_LDN'],
  [/\b(ny|new\s*york)\b.*\bsweep|ny\s*sweep|fut_sweep_ny/, 'FUT_SWEEP_NY'],
  [/\bfut_signal|futures?\s*signal|price\s*signal/, 'FUT_SIGNAL'],
  [/\bcalendar|cal_back|backwardation\b/, 'CAL_BACK'],
  [/\b(pre[\s-]*dawn|5\s*am|05:00|pre_long)\b/, 'PRE_LONG'],
  [/\b(evening|eve_long)\b|\b(17:30|5:30\s*pm)\s*(trade|straddle|entry|long)\b/, 'EVE_LONG'],
  [/\b(asia|10\s*am|10:00|asia_short)\b/, 'ASIA_SHORT'],
  [/\b(ny|new\s*york|22:30|10:30\s*pm|ny_short)\b/, 'NY_SHORT'],
];

const STRATEGY_GROUPS: Array<[RegExp, { label: string; ids: string[] }]> = [
  [/\bfutures?\b/, { label: 'futures strategies', ids: ['FUT_SWEEP_LDN', 'FUT_SWEEP_NY', 'FUT_SIGNAL'] }],
  [/\bstraddles?\b/, { label: 'long straddles', ids: ['EVE_LONG', 'PRE_LONG'] }],
  [/\b(short\s*strangles?|strangles?)\b/, { label: 'short strangles', ids: ['ASIA_SHORT', 'NY_SHORT'] }],
  [/\boptions?\b/, { label: 'option strategies', ids: ALL.filter((i) => !i.startsWith('FUT_')) }],
];

/** Words people use for each database table. The real table name is validated against the catalog. */
const TABLE_ALIASES: Array<[RegExp, string]> = [
  [/\btrade[\s_]*legs?\b/, 'trade_legs'],
  [/\b(chart[\s_]*)?drawings?\b/, 'chart_drawings'],
  [/\b(user[\s_]*)?preferences?\b/, 'user_preferences'],
  [/\balert[\s_]*rules?\b/, 'alert_rules'],
  [/\balert[\s_]*logs?\b/, 'alert_logs'],
  [/\b(market[\s_]*)?time[\s_]*series\b|\bmarket[\s_]*data\b/, 'market_timeseries'],
  [/\bindicator[\s_]*snapshots?\b|\bsnapshots?\b/, 'indicator_snapshots'],
  [/\boption[\s_]*flow\b|\bflow[\s_]*buckets?\b/, 'option_flow_buckets'],
  [/\bsession[\s_]*audit(?:[\s_]*logs?)?\b|\baudit[\s_]*logs?\b/, 'session_audit_logs'],
  [/\brecalibration(?:[\s_]*audits?)?\b/, 'recalibration_audits'],
  [/\bbot[\s_]*runs?\b/, 'bot_runs'],
  [/\bbot[\s_]*legs?\b/, 'bot_legs'],
  [/\bbot[\s_]*(fills?|executions?)\b/, 'bot_fills'],
  [/\bbot[\s_]*events?\b/, 'bot_events'],
  [/\b(minute[\s_]*marks?|minute[\s_]*records?|bot[\s_]*minute[\s_]*marks?)\b/, 'bot_minute_marks'],
  [/\bminute[\s_]*context\b/, 'bot_minute_context'],
  [/\bbot[\s_]*config\b/, 'bot_config'],
  [/\bnightly[\s_]*reviews?\b|\bnights\b/, 'nightly_reviews'],
  [/\b(users?|accounts?|credentials?|api[\s_]*keys?|push[\s_]*devices?)\b/, 'users'],
  [/\btrades\b|\btrades?[\s_]*table\b/, 'trades'],
];

export function parseTable(q: string): string | undefined {
  const direct = /\b(trade_legs|chart_drawings|user_preferences|alert_rules|alert_logs|market_timeseries|indicator_snapshots|option_flow_buckets|session_audit_logs|recalibration_audits|bot_runs|bot_legs|bot_fills|bot_events|bot_minute_marks|bot_minute_context|bot_config|nightly_reviews|trades|users|api_credentials|push_devices)\b/.exec(q);
  if (direct) return direct[1];
  for (const [re, name] of TABLE_ALIASES) if (re.test(q)) return name;
  return undefined;
}

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
  const direct = /\b(asia_short|ny_short|eve_long|pre_long|cal_back|fut_sweep_ldn|fut_sweep_ny|fut_signal)\b/i.exec(q);
  if (direct) return { strategy: direct[1]!.toUpperCase() };
  for (const [re, id] of STRATEGY_ALIASES) if (re.test(q)) return { strategy: id };
  for (const [re, g] of STRATEGY_GROUPS) if (re.test(q)) return { group: g };
  return {};
}

const has = (q: string, re: RegExp) => re.test(q);

/** A question about the future or a buy/sell call: it can only be answered from recorded facts, never forecast. */
export function isForecast(question: string): boolean {
  return /\b(will|predict|prediction|forecast|going to|gonna|expect|tomorrow|next week|next month|should i (buy|sell))\b/i.test(question);
}

export function parseQuestion(raw: string, nowMs: number = Date.now()): Parsed {
  const q = ` ${raw.toLowerCase().replace(/[?!]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const time = parseTime(q);
  const base = { raw, ...parseStrategy(q), period: parsePeriod(q, nowMs), time, dateKey: parseDate(q, nowMs), table: parseTable(q) };
  const limit = (() => {
    const m = /\b(?:top|last|latest|recent)\s+(\d{1,2})\b/.exec(q);
    return m ? Number(m[1]) : undefined;
  })();
  const out = (intent: Intent): Parsed => ({ ...base, intent, limit });

  // adding to / removing from the user's own notes comes first: the raw text matters, not the lowercased words
  const teach = /^\s*(?:teach(?:\s+me)?|remember|note)\s*[:,-]?\s*(.+?)\s*(?:=>|->|=)\s*([\s\S]+)$/i.exec(raw);
  if (teach) return { ...out('teach'), note: { q: teach[1]!.trim(), a: teach[2]!.trim() } };
  const forget = /^\s*forget\s+(?:note\s+)?#?(\d{1,6})\s*$/i.exec(raw);
  if (forget) return { ...out('forget'), noteId: Number(forget[1]) };
  if (has(q, /\b(what (?:have|did) i (?:taught|told|teach)|my notes|what do you remember|show (?:my )?notes|list (?:my )?notes|taught you)\b/)) return out('notes');

  if (has(q, /\b(help|what can you|what do you|commands|capabilit\w*|how do i ask|examples)\b/)) return out('help');

  const defining = has(q, /^ (what is|what's|what are|explain|define|how does|how do|how is|how are|how can|why is|why does|meaning of)\b/);
  // what auto-learn has actually done (a definition of auto-learn is a glossary question)
  if (!defining && has(q, /\b(learned|learnt|promoted|promotions?|champions?|challengers?|rule change|rules? changed|learning (?:status|log|history|review)|auto.?learn\w*|last review|did (?:it|the bot) (?:change|upgrade|learn))\b/)) return out('learning');
  // the user's own paper account (not the bot): balance, positions, orders, fills. "my paper ..." is always about the data.
  if (has(q, /\bmy paper\b/) || (!defining && has(q, /\bpaper (?:account|trading|trades?|terminal|balance|equity|positions?|orders?|fills?|pnl|cash)\b/))) return out('paper');
  // questions about how the newest features work are glossary questions, even when they name a strategy
  if (defining && has(q, /\b(liquidat\w*|reduce.only|bracket|order types?|limit order|stop order|market order|maker|taker|slippage|theta|gamma|vega|premium)\b/)) return out('concept');
  if (has(q, /\b(wait window|how long (?:does|do|will|is)\b.*\b(?:wait|keep|try|check)\w*|keeps? (?:checking|trying)|waits? for (?:a |the )?(?:valid )?(?:entry|trade)|banner|flashing card|shadow marks?)\b/)) return out('concept');

  // "what data do you have": the whole database, not one table
  if (has(q, /\b(what|which|list|show)\b.*\b(data|tables?|records?|information)\b.*\b(you|have|available|stored|database|db|access|know|see)\b|\b(summar\w*|overview|contents?|inventory)\b.*\b(database|db)\b|\b(database|db)\b.*\b(summary|overview|tables|contents|inventory)\b|\ball (the )?tables\b|\bwhat (?:do|can) you (?:know|see|access|read)\b|\bhow much data\b|\bwhat.?s stored\b|\bdata (?:you|do you) have\b|\beverything (?:you|that) (?:have|know)\b/) && !(base.table && has(q, /\b(summar|describe|columns?|rows)/))) return out('data_overview');

  // a generic "tell me about this table" request
  if (base.table && has(q, /\b(summar\w*|describe|columns?|schema|how many rows|row count|rows in|contents? of|what.?s in|overview of|profile|stats? (?:of|for|on)|show (?:me )?(?:the )?(?:latest|last|recent|all)|latest rows?|look at|data in|table)\b/)) return out('table_summary');

  const askingAt = time && has(q, /\b(happen\w*|saw|see|seeing|doing|state|record\w*|positions?|going on|status)\b/);
  if (askingAt && !has(q, /\b(entry|enter|entered)\b.*\b(rule|when)\b/)) return out('at_time');

  const hasPastRun = has(q, /\b(today|yesterday|tonight|last night|this morning)\b|\b20\d{2}-\d{2}-\d{2}\b/);
  if (has(q, /\bwhy (is|are|does|do)\b/) && !hasPastRun) return out('concept');
  if (has(q, /\b(when|what time|which time|best time)\b.*\b(enter|entry|sell|start|trade)\b/) && !has(q, /\b(exit|close)\b/)) return out('concept');

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

  if (has(q, /\b(what is|what's|what are|what does|what do|meaning of|mean by|means|explain|define|definition of|tell me about|how does|how do|why is|why does|difference between)\b/)) return out('concept');

  if (has(q, /\b(will|predict|prediction|forecast|going to|gonna|expect|tomorrow|next week|next month|should i (buy|sell))\b/) && !has(q, /\b(pnl|trade|trades|position|positions|strateg\w*|rule|rules)\b/)) return out('unknown');

  if (has(q, /\b(market|spot|price|btc|dvol|iv|volatility|funding|open interest|oi|macro|stress|vix|gate|go or wait)\b/)) return out('market');

  if (has(q, /\b(pnl|p&l|profit|loss|made|earned|win\s*rate|result|results|performance|summary|how much|stats|statistics|total|fees|stop rate)\b/)) return out('pnl');

  if (base.strategy || base.group) return out('pnl');
  return out('unknown');
}

export const SUGGESTIONS = [
  'Running positions',
  'What has auto-learn changed?',
  'My paper account',
  'Teach: what is my Friday plan => full size at 23:00',
  "Today's PnL",
  'This week by strategy',
  'Why was the last trade stopped?',
  'Why no trade today?',
  'Best session',
  'Market now',
  'What data do you have?',
  'Summarise bot runs',
  'What is Risk-ADX?',
  'Explain N2N',
  'Recent errors',
  'What is the NY short rule?',
];
