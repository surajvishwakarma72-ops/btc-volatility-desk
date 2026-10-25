import type { Parsed } from '../../lib/ask/parse.js';

/**
 * Generic, read-only exploration of whatever tables exist in the desk's database: what is stored,
 * how much, over which dates, and a profile of any one table (row counts, ranges, averages, the most
 * common values, the latest rows). Table and column names are only ever taken from the database's own
 * catalog (never from the question) and quoted, so a question cannot inject SQL. Credentials, password
 * hashes and push tokens are never shown.
 */
export interface ExploreContext {
  q(sql: string, params?: unknown[]): Promise<Array<Record<string, any>>>;
  now: number;
}

export interface ExploreAnswer {
  text: string;
  table?: { head: string[]; rows: Array<Array<string | number>> };
  sources: string[];
}

export const BLOCKED_TABLES = new Set(['users', 'api_credentials', 'push_devices']);
/** Column names that can hold secrets; never selected. "tags" is fine, "tag" (an auth tag) is not. */
export const HIDDEN_COLUMN = /^(password.*|.*_hash|.*secret.*|.*token.*|salt|iv|tag|encrypted.*|api_key|api_secret|auth.*|fcm.*|endpoint|p256dh|keys?)$/i;

const IST = 19_800_000;
const TIME_COLUMNS = ['recorded_at', 'entry_at', 'entry_time', 'delivered_at', 'run_at', 'at', 'time', 'session_date', 'created_at', 'updated_at'];
const NUMERIC = new Set(['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision']);
const TEXTY = new Set(['text', 'character varying', 'character']);
const TIMEY = new Set(['timestamp with time zone', 'timestamp without time zone', 'date']);

export const TABLE_INFO: Record<string, string> = {
  trades: 'trades you logged on the desk (strikes, entry/exit, realised PnL)',
  trade_legs: 'the call and put leg of each logged trade',
  nightly_reviews: 'one review per night: verdict, outcome, IV readings, notes',
  chart_drawings: 'lines and levels you drew on the charts',
  user_preferences: 'your saved desk settings',
  alert_rules: 'alert conditions you set',
  alert_logs: 'every alert that was sent',
  market_timeseries: 'stored market candles and series',
  indicator_snapshots: '5-minute snapshots of IV, term structure, skew, funding and open interest',
  option_flow_buckets: '15-minute option flow aggregates',
  session_audit_logs: 'one row per session (traded or skipped) with what the screen showed vs the locked rule',
  recalibration_audits: 'results of the daily Bonferroni and out-of-sample re-test',
  bot_runs: 'every paper trade the bot took or skipped',
  bot_legs: 'the legs of each bot trade',
  bot_fills: 'every simulated fill with intended vs actual price and fee',
  bot_minute_marks: 'minute-by-minute PnL of every open bot position',
  bot_minute_context: 'market context recorded every minute by the bot',
  bot_events: 'the bot\'s event log (entries, exits, skips, errors)',
  bot_config: 'bot pause and kill-switch state',
};

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;
const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function fmtVal(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return `${new Date(v.getTime() + IST).toISOString().slice(0, 16).replace('T', ' ')} IST`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
  const s = String(v);
  if (/^-?\d+\.\d{4,}$/.test(s)) return String(Number(Number(s).toFixed(4)));
  return s.length > 38 ? `${s.slice(0, 36)}…` : s;
}

const fmtNum = (v: number | null): string => (v == null ? '-' : Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Number(v.toFixed(3))));

export interface Catalog {
  tables: Map<string, Array<{ name: string; type: string }>>;
}

export async function loadCatalog(c: ExploreContext): Promise<Catalog> {
  const rows = await c.q(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const tables = new Map<string, Array<{ name: string; type: string }>>();
  for (const r of rows) {
    if (BLOCKED_TABLES.has(r.table_name)) continue;
    (tables.get(r.table_name) ?? tables.set(r.table_name, []).get(r.table_name)!).push({ name: r.column_name, type: r.data_type });
  }
  return { tables };
}

export function timeColumn(cols: Array<{ name: string; type: string }>): string | null {
  for (const want of TIME_COLUMNS) if (cols.some((c) => c.name === want && TIMEY.has(c.type))) return want;
  return cols.find((c) => TIMEY.has(c.type))?.name ?? null;
}

/** Map a question word to a real table name using the catalog (exact name, then a unique prefix/contains match). */
export function resolveTable(hint: string | undefined, cat: Catalog): string | null {
  if (!hint) return null;
  if (cat.tables.has(hint)) return hint;
  const flat = hint.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found = [...cat.tables.keys()].filter((t) => t.replace(/_/g, '') === flat || t.replace(/_/g, '').includes(flat));
  return found.length === 1 ? found[0]! : null;
}

export async function dataOverview(c: ExploreContext): Promise<ExploreAnswer> {
  const cat = await loadCatalog(c);
  const rows: Array<Array<string | number>> = [];
  let total = 0;
  for (const [name, cols] of [...cat.tables.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const tc = timeColumn(cols);
    const r = (await c.q(tc ? `SELECT COUNT(*)::int AS n, MIN(${qi(tc)}) AS lo, MAX(${qi(tc)}) AS hi FROM ${qi(name)}` : `SELECT COUNT(*)::int AS n FROM ${qi(name)}`))[0] ?? { n: 0 };
    total += r.n;
    rows.push([name, r.n, tc && r.lo ? fmtVal(r.lo) : '', tc && r.hi ? fmtVal(r.hi) : '', TABLE_INFO[name] ?? '']);
  }
  const withData = rows.filter((r) => Number(r[1]) > 0).length;
  return {
    sources: ['database catalog'],
    text: [
      `The database has ${rows.length} readable tables, ${withData} of them with data, ${total.toLocaleString('en-US')} rows in total.`,
      'Ask me to summarise any one (for example "summarise bot runs" or "describe indicator snapshots") or ask about a period ("alert logs last 7 days").',
      'Besides the database I can read the live market feeds and the terminal\'s written docs and glossary. Some history lives only in your browser\'s own storage (for example the IV charts\' cached ticks); that is not in the database and I cannot see it.',
      'For safety I never show user accounts, API credentials or push-device tokens.',
    ].join('\n'),
    table: { head: ['Table', 'Rows', 'First record', 'Latest record', 'What it holds'], rows },
  };
}

export async function tableSummary(p: Parsed, c: ExploreContext): Promise<ExploreAnswer> {
  const cat = await loadCatalog(c);
  const name = resolveTable(p.table, cat);
  if (!name) {
    const blocked = p.table && BLOCKED_TABLES.has(p.table);
    return {
      sources: ['database catalog'],
      text: blocked
        ? `I do not open "${p.table}": it holds accounts or credentials, which I never show.`
        : `I could not find a table matching "${p.table ?? 'that'}". Tables I can read: ${[...cat.tables.keys()].sort().join(', ')}.`,
    };
  }
  const cols = cat.tables.get(name)!;
  const visible = cols.filter((x) => !HIDDEN_COLUMN.test(x.name));
  const tc = timeColumn(cols);
  const per = p.period && tc ? p.period : null;
  const where = per ? `WHERE ${qi(tc!)} >= to_timestamp($1::float8/1000.0) AND ${qi(tc!)} < to_timestamp($2::float8/1000.0)` : '';
  const params = per ? [per.from, per.to] : [];

  const numCols = visible.filter((x) => NUMERIC.has(x.type) && !/(^id$|_id$|_ms$)/.test(x.name)).slice(0, 6);
  const txtCols = visible.filter((x) => TEXTY.has(x.type) && !/(message|notes?|description|text|body|detail|_key$)/i.test(x.name)).slice(0, 12);
  const agg = [
    'COUNT(*)::int AS n',
    ...(tc ? [`MIN(${qi(tc)}) AS lo`, `MAX(${qi(tc)}) AS hi`] : []),
    ...numCols.flatMap((x, i) => [`AVG(${qi(x.name)})::float AS a${i}`, `MIN(${qi(x.name)})::float AS m${i}`, `MAX(${qi(x.name)})::float AS x${i}`, `SUM(${qi(x.name)})::float AS s${i}`]),
    ...txtCols.map((x, i) => `COUNT(DISTINCT ${qi(x.name)})::int AS d${i}`),
  ].join(', ');
  const [a] = await c.q(`SELECT ${agg} FROM ${qi(name)} ${where}`, params);
  const n: number = a?.n ?? 0;
  const [all] = per ? await c.q(`SELECT COUNT(*)::int AS n FROM ${qi(name)}`) : [a];

  const lines: string[] = [];
  lines.push(`${name}: ${TABLE_INFO[name] ?? 'a table in the database'}.`);
  lines.push(per ? `${n.toLocaleString('en-US')} rows in ${per.label} (${(all?.n ?? 0).toLocaleString('en-US')} in total).` : `${n.toLocaleString('en-US')} rows.`);
  if (tc && a?.lo) lines.push(`${tc} runs from ${fmtVal(a.lo)} to ${fmtVal(a.hi)}.`);
  if (n === 0) {
    lines.push('There is nothing in it for that selection.');
    return { sources: [name], text: lines.join('\n') };
  }

  const rows: Array<Array<string | number>> = [];
  numCols.forEach((x, i) => rows.push([x.name, 'number', fmtNum(num(a[`a${i}`])), fmtNum(num(a[`m${i}`])), fmtNum(num(a[`x${i}`])), fmtNum(num(a[`s${i}`]))]));

  const common: string[] = [];
  for (let i = 0; i < txtCols.length && common.length < 5; i++) {
    const d = a[`d${i}`] ?? 0;
    if (d < 1 || d > 20) continue;
    const top = await c.q(`SELECT ${qi(txtCols[i]!.name)} AS v, COUNT(*)::int AS k FROM ${qi(name)} ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, params);
    common.push(`${txtCols[i]!.name}: ${top.map((t) => `${t.v ?? 'empty'} (${t.k})`).join(', ')}`);
  }
  if (common.length) lines.push('Most common values: ' + common.join('; ') + '.');
  if (numCols.length) lines.push('Numbers (average, smallest, largest, total) are in the first table below.');

  const latestCols = visible.slice(0, 8);
  const latest = await c.q(`SELECT ${latestCols.map((x) => qi(x.name)).join(', ')} FROM ${qi(name)} ${where} ${tc ? `ORDER BY ${qi(tc)} DESC` : ''} LIMIT ${Math.min(p.limit ?? 5, 20)}`, params);
  lines.push(`Columns: ${visible.map((x) => x.name).join(', ')}${cols.length > visible.length ? ` (${cols.length - visible.length} hidden for safety)` : ''}.`);

  const spacer = Array(6).fill('') as string[];
  const out: Array<Array<string | number>> = [];
  if (rows.length) out.push(['Column', 'Type', 'Average', 'Smallest', 'Largest', 'Total'], ...rows);
  if (latest.length) {
    if (out.length) out.push(spacer);
    out.push([`Latest ${latest.length} rows`, ...Array(5).fill('')] as string[]);
    out.push(latestCols.slice(0, 6).map((x) => x.name));
    for (const r of latest) out.push(latestCols.slice(0, 6).map((x) => fmtVal(r[x.name])));
  }
  return {
    sources: [name],
    text: lines.join('\n'),
    table: out.length ? { head: out[0] as string[], rows: out.slice(1).map((r) => [...r, ...Array(Math.max(0, 6 - r.length)).fill('')]) } : undefined,
  };
}
