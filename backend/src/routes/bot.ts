import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/index.js';
import { DAY, istDateKey, istMidnightMs } from '../lib/bot/schedule.js';
import { requireAdmin } from '../lib/guards.js';
import { analyzeSeries, analyzeTrades, type SeriesPoint, type TradeRec } from '../lib/bot/pnl-analysis.js';
import { buildTimeline, type SlotRun } from '../lib/bot/timeline.js';
import { buildAnalytics, type RunRecord } from '../lib/bot/analytics.js';
import { DEFAULT_PARAMS, DEFAULT_THRESHOLDS } from '../lib/bot/learn.js';
import { pickTop } from '../lib/bot/top.js';
import { STRATEGY_NAMES } from '../lib/ask/parse.js';
import { botEngine } from '../services/bot/bot-engine.js';
import { ensureBotSchema, getConfig, getParams, setConfig } from '../services/bot/bot-store.js';
import { LEARNED_STRATEGIES, autoLearnOn, rollbackLast, runLearning } from '../services/bot/learner.js';

/**
 * Read-only query surface for the paper trading bot, plus pause/resume/kill. Every route needs
 * the desk JWT. There is deliberately no endpoint that places an order or arms live trading.
 */
export const botRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };
  const q = <T extends Record<string, string | undefined>>(req: { query: unknown }) => (req.query ?? {}) as T;
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: string) =>
    reply.code(400).send({ success: false, error });

  fastify.get('/status', auth, async () => {
    const cfg = botEngine.enabled ? await getConfig().catch(() => null) : null;
    return {
      success: true,
      enabled: botEngine.enabled,
      engine: botEngine.status,
      lastTickAt: botEngine.lastTickAt || null,
      lastError: botEngine.lastError,
      mode: process.env.BOT_MODE ?? 'paper',
      paused: cfg?.paused ?? null,
      killSwitch: cfg?.kill_switch ?? null,
      waiting: botEngine.enabled ? botEngine.waitingEntries() : [],
    };
  });

  fastify.get('/positions', auth, async (_req, reply) => {
    if (!botEngine.enabled) return reply.code(409).send({ success: false, error: 'bot is disabled (BOT_ENABLED)' });
    return { success: true, positions: await botEngine.livePositions() };
  });

  fastify.get('/runs', auth, async (req) => {
    await ensureBotSchema();
    const { strategy, status, limit } = q<{ strategy?: string; status?: string; limit?: string }>(req);
    const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const r = await pool.query(
      `SELECT r.*, (SELECT COALESCE(SUM(ABS(f.avg_price - f.intended_price) * f.filled * 0.001), 0)::float FROM bot_fills f WHERE f.run_id = r.id) AS slippage_usd
         FROM bot_runs r WHERE ($1::text IS NULL OR r.strategy=$1) AND ($2::text IS NULL OR r.status=$2) ORDER BY r.created_at DESC LIMIT $3`,
      [strategy ?? null, status ?? null, n],
    );
    return { success: true, runs: r.rows };
  });

  // Every scheduled slot of the IST day (and last night's overnight one) with where it stands, for the Bot page's "Today" panel.
  // Options and futures PnL side by side for the top of the Bot page: open now, closed today / 7 days / all time. Always book only,
  // because the gated book repeats the same trades on GO days and would count them twice.
  fastify.get('/pnl', auth, async () => {
    await ensureBotSchema();
    const now = Date.now();
    const dayStart = istMidnightMs(istDateKey(now));
    const r = await pool.query(
      `SELECT (strategy LIKE 'FUT\\_%') AS fut, COUNT(*)::int AS trades, COUNT(*) FILTER (WHERE net_pnl > 0)::int AS wins,
              COALESCE(SUM(net_pnl), 0)::float AS total,
              COALESCE(SUM(net_pnl) FILTER (WHERE exit_at >= to_timestamp($1 / 1000.0)), 0)::float AS today,
              COALESCE(SUM(net_pnl) FILTER (WHERE exit_at >= to_timestamp($2 / 1000.0)), 0)::float AS week,
              COUNT(*) FILTER (WHERE exit_at >= to_timestamp($1 / 1000.0))::int AS today_trades
         FROM bot_runs WHERE status = 'closed' AND net_pnl IS NOT NULL AND book <> 'gated' GROUP BY 1`,
      [dayStart, now - 7 * DAY],
    );
    const live = botEngine.enabled ? await botEngine.livePositions().catch(() => []) : [];
    const side = (fut: boolean) => {
      const row = (r.rows as any[]).find((x) => !!x.fut === fut);
      const open = (live as any[]).filter((p) => p.book !== 'gated' && String(p.strategy).startsWith('FUT_') === fut);
      const openPnl = open.reduce((a, p) => a + (p.pnl ? p.pnl.netPnl : 0), 0);
      return {
        openCount: open.length, openPnl, openKnown: open.every((p) => p.pnl),
        today: row ? Number(row.today) : 0, todayTrades: row ? Number(row.today_trades) : 0, week: row ? Number(row.week) : 0,
        total: row ? Number(row.total) : 0, trades: row ? Number(row.trades) : 0, wins: row ? Number(row.wins) : 0,
      };
    };
    return { success: true, now, engine: botEngine.status, options: side(false), futures: side(true) };
  });

  fastify.get('/today', auth, async () => {
    await ensureBotSchema();
    const now = Date.now();
    const dates = [istDateKey(now - DAY), istDateKey(now)];
    const rows = await pool.query(
      `SELECT id, run_key, book, status, tags, entry_at, exit_at, planned_exit_at, margin_usd, gross_pnl, net_pnl, fees_entry, fees_exit, exit_reason, exit_detail
         FROM bot_runs WHERE date_key = ANY($1::text[]) AND strategy NOT LIKE 'FUT\\_%'`,
      [dates],
    );
    const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);
    const num = (v: unknown) => (v == null ? null : Number(v));
    const map = new Map<string, SlotRun>();
    for (const r of rows.rows as any[]) {
      map.set(r.run_key, {
        id: r.id, book: r.book, status: r.status, tags: r.tags, netPnl: num(r.net_pnl), grossPnl: num(r.gross_pnl),
        fees: r.fees_entry == null ? null : Number(r.fees_entry) + Number(r.fees_exit ?? 0),
        entryAtMs: ms(r.entry_at), exitAtMs: ms(r.exit_at), plannedExitAtMs: ms(r.planned_exit_at), exitReason: r.exit_reason, exitDetail: r.exit_detail, marginUsd: num(r.margin_usd),
      });
    }
    const live = botEngine.enabled ? await botEngine.livePositions().catch(() => []) : [];
    const livePnl = new Map<string, { netPnl: number; grossPnl: number; pctOfMargin: number }>();
    for (const p of live as any[]) if (p.id && p.pnl) livePnl.set(p.id, { netPnl: p.pnl.netPnl, grossPnl: p.pnl.grossPnl, pctOfMargin: p.pnl.pctOfMargin });
    const slots = buildTimeline(now, map, botEngine.enabled ? botEngine.waitingEntries() : []).map((s) => ({
      ...s, live: s.run?.id ? livePnl.get(s.run.id) ?? null : null,
    }));
    return { success: true, now, enabled: botEngine.enabled, engine: botEngine.status, lastTickAt: botEngine.lastTickAt || null, lastError: botEngine.lastError, slots };
  });

  fastify.get('/runs/:id/timeline', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { from, to, step } = q<{ from?: string; to?: string; step?: string }>(req);
    const stepMin = step === '5m' ? 5 : step === '15m' ? 15 : step === '1h' ? 60 : 1;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(reply, 'invalid run id');
    await ensureBotSchema();
    const r = await pool.query(
      `SELECT minute_ms, net_pnl, gross_pnl, pct_margin, spot, snapshot FROM bot_minute_marks
       WHERE run_id=$1 AND ($2::bigint IS NULL OR minute_ms >= $2) AND ($3::bigint IS NULL OR minute_ms <= $3)
       AND (minute_ms / 60000) % $4 = 0 ORDER BY minute_ms`,
      [id, from ? Number(from) : null, to ? Number(to) : null, stepMin],
    );
    return { success: true, stepMinutes: stepMin, points: r.rows };
  });

  // What the bot saw and did at one IST minute, across all strategies.
  fastify.get('/at', auth, async (req, reply) => {
    const { time, date } = q<{ time?: string; date?: string }>(req);
    const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? '');
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return bad(reply, 'time must be HH:MM (IST)');
    const day = date ?? istDateKey(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return bad(reply, 'date must be YYYY-MM-DD (IST)');
    await ensureBotSchema();
    const minuteMs = istMidnightMs(day) + (Number(m[1]) * 60 + Number(m[2])) * 60_000;
    const [marks, ctx, events] = await Promise.all([
      pool.query(
        `SELECT mm.*, r.strategy, r.book FROM bot_minute_marks mm JOIN bot_runs r ON r.id = mm.run_id WHERE mm.minute_ms = $1`,
        [minuteMs],
      ),
      pool.query('SELECT * FROM bot_minute_context WHERE minute_ms = $1', [minuteMs]),
      pool.query(
        `SELECT * FROM bot_events WHERE at >= to_timestamp($1/1000.0) AND at < to_timestamp(($1+60000)/1000.0) ORDER BY at`,
        [minuteMs],
      ),
    ]);
    return { success: true, minuteMs, istDate: day, positions: marks.rows, context: ctx.rows[0] ?? null, events: events.rows };
  });

  fastify.get('/runs/:id/explain', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(reply, 'invalid run id');
    await ensureBotSchema();
    const [run, legs, fills, events, peak] = await Promise.all([
      pool.query('SELECT * FROM bot_runs WHERE id=$1', [id]),
      pool.query('SELECT * FROM bot_legs WHERE run_id=$1 ORDER BY id', [id]),
      pool.query('SELECT * FROM bot_fills WHERE run_id=$1 ORDER BY id', [id]),
      pool.query('SELECT * FROM bot_events WHERE run_id=$1 ORDER BY at', [id]),
      pool.query('SELECT MIN(minute_ms) AS first, MAX(minute_ms) AS last, COUNT(*) AS minutes FROM bot_minute_marks WHERE run_id=$1', [id]),
    ]);
    if (!run.rowCount) return reply.code(404).send({ success: false, error: 'run not found' });
    const r = run.rows[0];
    const slippage = fills.rows.reduce((s: number, f: any) => s + Math.abs(Number(f.avg_price) - Number(f.intended_price)) * f.filled * 0.001, 0);
    return {
      success: true,
      run: r,
      legs: legs.rows.map((l: any) => ({
        ...l,
        pnl: l.exit_price == null ? null : (l.side === 'short' ? Number(l.entry_price) - Number(l.exit_price) : Number(l.exit_price) - Number(l.entry_price)) * l.lots * 0.001,
      })),
      fills: fills.rows,
      events: events.rows,
      recording: peak.rows[0],
      summary: {
        exitReason: r.exit_reason,
        exitDetail: r.exit_detail,
        netPnl: r.net_pnl,
        peakPnl: r.peak_pnl,
        troughPnl: r.trough_pnl,
        gaveBackFromPeak: r.peak_pnl != null && r.net_pnl != null ? Number(r.peak_pnl) - Number(r.net_pnl) : null,
        slippageUsd: slippage,
        feesUsd: Number(r.fees_entry ?? 0) + Number(r.fees_exit ?? 0),
      },
    };
  });

  // One trade, minute by minute: the net PnL line from entry to exit (or now), each leg's mark / PnL / IV, the take-profit target,
  // the events on that trade, and the statistics a trader reads off it (peak, trough, drawdown, time in profit).
  fastify.get('/runs/:id/pnl', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(reply, 'invalid run id');
    await ensureBotSchema();
    const [run, marks, legsT, events] = await Promise.all([
      pool.query('SELECT * FROM bot_runs WHERE id=$1', [id]),
      pool.query('SELECT minute_ms, net_pnl, gross_pnl, pct_margin, spot, snapshot FROM bot_minute_marks WHERE run_id=$1 ORDER BY minute_ms', [id]),
      pool.query('SELECT symbol, side, role, entry_price, exit_price, lots FROM bot_legs WHERE run_id=$1 ORDER BY id', [id]),
      pool.query('SELECT at, type, severity, message FROM bot_events WHERE run_id=$1 ORDER BY at LIMIT 60', [id]),
    ]);
    if (!run.rowCount) return reply.code(404).send({ success: false, error: 'run not found' });
    const r = run.rows[0] as any;
    const rows = marks.rows as any[];
    const points: SeriesPoint[] = rows.map((m) => ({ t: Number(m.minute_ms), net: Number(m.net_pnl), gross: Number(m.gross_pnl), spot: m.spot == null ? null : Number(m.spot), pct: m.pct_margin == null ? null : Number(m.pct_margin) }));
    const bySym = new Map<string, { symbol: string; side: string; role: string; entry: number | null; mark: Array<number | null>; pnl: Array<number | null>; iv: Array<number | null>; delta: Array<number | null> }>();
    for (const l of legsT.rows as any[]) bySym.set(l.symbol, { symbol: l.symbol, side: l.side, role: l.role, entry: l.entry_price == null ? null : Number(l.entry_price), mark: [], pnl: [], iv: [], delta: [] });
    const n = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    rows.forEach((m, i) => {
      const sn = (typeof m.snapshot === 'string' ? JSON.parse(m.snapshot) : m.snapshot) as { legs?: Array<{ symbol: string; mark?: number | null; pnl?: number | null; iv?: number | null; delta?: number | null }> } | null;
      const seen = new Set<string>();
      for (const l of sn?.legs ?? []) {
        const s = bySym.get(l.symbol); if (!s) continue; seen.add(l.symbol);
        s.mark[i] = n(l.mark); s.pnl[i] = n(l.pnl); s.iv[i] = n(l.iv); s.delta[i] = n(l.delta);
      }
      for (const s of bySym.values()) if (!seen.has(s.symbol)) { s.mark[i] = null; s.pnl[i] = null; s.iv[i] = null; s.delta[i] = null; }
    });
    const last = rows.length ? ((typeof rows[rows.length - 1].snapshot === 'string' ? JSON.parse(rows[rows.length - 1].snapshot) : rows[rows.length - 1].snapshot) as any) : null;
    const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);
    return {
      success: true,
      run: {
        id: r.id, strategy: r.strategy, book: r.book, status: r.status, dateKey: r.date_key, entryMs: ms(r.entry_at), exitMs: ms(r.exit_at), plannedExitMs: ms(r.planned_exit_at),
        margin: n(r.margin_usd), feesEntry: n(r.fees_entry), feesExit: n(r.fees_exit), net: n(r.net_pnl), gross: n(r.gross_pnl), exitReason: r.exit_reason ?? null, exitDetail: r.exit_detail ?? null,
      },
      t: points.map((p) => p.t), net: points.map((p) => p.net), gross: points.map((p) => p.gross), spot: points.map((p) => p.spot), pct: points.map((p) => p.pct),
      legs: [...bySym.values()],
      tp: n(last?.tpTargetUsd), stops: last?.stopLevels ?? [],
      events: (events.rows as any[]).map((e) => ({ at: new Date(e.at).getTime(), type: e.type, severity: e.severity, message: String(e.message ?? '').slice(0, 200) })),
      stats: analyzeSeries(points),
    };
  });

  // All closed trades as one run: the equity curve with its drawdown and the statistics (always book only, so the gated copy is never counted twice).
  fastify.get('/pnl/trades', auth, async (req) => {
    await ensureBotSchema();
    const { scope, limit } = q<{ scope?: string; limit?: string }>(req);
    const lim = Math.min(Math.max(Number(limit) || 400, 1), 2000);
    const r = await pool.query(
      `SELECT id, strategy, book, date_key, entry_at, exit_at, margin_usd, gross_pnl, net_pnl, fees_entry, fees_exit, exit_reason FROM bot_runs
        WHERE status = 'closed' AND net_pnl IS NOT NULL AND book <> 'gated' AND exit_at IS NOT NULL AND entry_at IS NOT NULL
          AND ($1::text IS NULL OR ($1 = 'futures' AND strategy LIKE 'FUT\\_%') OR ($1 = 'options' AND strategy NOT LIKE 'FUT\\_%') OR strategy = $1)
        ORDER BY exit_at DESC LIMIT $2`,
      [scope && /^[A-Za-z_]{3,30}$/.test(scope) && scope !== 'all' ? scope : null, lim],
    );
    const trades: TradeRec[] = (r.rows as any[]).map((x) => ({
      id: x.id, strategy: x.strategy, book: x.book, dateKey: x.date_key, entryMs: new Date(x.entry_at).getTime(), exitMs: new Date(x.exit_at).getTime(),
      net: Number(x.net_pnl), gross: Number(x.gross_pnl ?? x.net_pnl), fees: Number(x.fees_entry ?? 0) + Number(x.fees_exit ?? 0), margin: x.margin_usd == null ? null : Number(x.margin_usd), reason: x.exit_reason ?? null,
    }));
    return { success: true, ...analyzeTrades(trades) };
  });

  fastify.get('/events', auth, async (req) => {
    await ensureBotSchema();
    const { strategy, type, severity, limit } = q<{ strategy?: string; type?: string; severity?: string; limit?: string }>(req);
    const r = await pool.query(
      `SELECT * FROM bot_events WHERE ($1::text IS NULL OR strategy=$1) AND ($2::text IS NULL OR type=$2) AND ($3::text IS NULL OR severity=$3) ORDER BY at DESC LIMIT $4`,
      [strategy ?? null, type ?? null, severity ?? null, Math.min(Math.max(Number(limit) || 100, 1), 1000)],
    );
    return { success: true, events: r.rows };
  });

  fastify.get('/analytics/summary', auth, async () => {
    await ensureBotSchema();
    const r = await pool.query(`
      SELECT strategy, book, COUNT(*)::int AS trades,
             SUM(net_pnl)::float AS net_pnl, AVG(net_pnl)::float AS avg_pnl,
             AVG((net_pnl > 0)::int)::float AS win_rate,
             AVG((exit_reason = 'stop')::int)::float AS stop_rate,
             AVG((exit_reason = 'tp')::int)::float AS tp_rate,
             SUM(COALESCE(fees_entry,0) + COALESCE(fees_exit,0))::float AS fees,
             AVG(COALESCE(peak_pnl,0) - net_pnl)::float AS avg_give_back
        FROM bot_runs WHERE status = 'closed' GROUP BY strategy, book ORDER BY strategy, book`);
    return { success: true, summary: r.rows };
  });

  /** Closed runs with their 15-minute PnL paths, in the shape the shared analytics code takes. */
  const loadRecordsRaw = async (): Promise<RunRecord[]> => {
    await ensureBotSchema();
    const runs = await pool.query(
      `SELECT id, strategy, book, date_key, entry_at, exit_at, margin_usd, fees_entry, fees_exit, net_pnl, exit_reason, peak_pnl, trough_pnl, tags
         FROM bot_runs WHERE status = 'closed' AND net_pnl IS NOT NULL ORDER BY exit_at`,
    );
    const marks = await pool.query(
      `SELECT m.run_id, m.minute_ms, m.net_pnl FROM bot_minute_marks m JOIN bot_runs r ON r.id = m.run_id
        WHERE r.status = 'closed' AND (m.minute_ms / 60000) % 15 = 0 ORDER BY m.run_id, m.minute_ms`,
    );
    const paths = new Map<string, Array<[number, number]>>();
    const entry = new Map<string, number>(runs.rows.map((r: any) => [r.id, new Date(r.entry_at).getTime()]));
    for (const m of marks.rows as any[]) {
      const off = Math.round((Number(m.minute_ms) - entry.get(m.run_id)!) / 60_000);
      (paths.get(m.run_id) ?? paths.set(m.run_id, []).get(m.run_id)!).push([off, Number(m.net_pnl)]);
    }
    return (runs.rows as any[]).map((r) => {
      const entryMs = new Date(r.entry_at).getTime();
      const exitMs = new Date(r.exit_at).getTime();
      const net = Number(r.net_pnl);
      const p = paths.get(r.id) ?? [];
      const path: Array<[number, number]> = [[0, -Number(r.fees_entry ?? 0)], ...p.filter(([o]) => o > 0 && o < (exitMs - entryMs) / 60_000)];
      path.push([Math.round((exitMs - entryMs) / 60_000), net]);
      const gate = (r.tags as any)?.gate;
      return {
        strategy: r.strategy,
        book: r.book,
        dateKey: r.date_key,
        weekday: new Date(`${r.date_key}T00:00:00Z`).getUTCDay(),
        entryMs,
        exitMs,
        entryIv: null,
        dvol: gate?.dvol ?? null,
        gateGo: gate ? !!gate.go : null,
        marginUsd: Number(r.margin_usd ?? 0),
        feesUsd: Number(r.fees_entry ?? 0) + Number(r.fees_exit ?? 0),
        netPnl: net,
        exitReason: r.exit_reason ?? 'unknown',
        peakPnl: Number(r.peak_pnl ?? net),
        troughPnl: Number(r.trough_pnl ?? net),
        path,
      };
    });
  };

  // /analytics and /top both need every closed run with its PnL path, which is the slow query on this page: share one result for a minute.
  let recCache: { at: number; p: Promise<RunRecord[]> } | null = null;
  const loadRecords = (): Promise<RunRecord[]> => {
    if (recCache && Date.now() - recCache.at < 60_000) return recCache.p;
    const p = loadRecordsRaw();
    recCache = { at: Date.now(), p };
    p.catch(() => { if (recCache && recCache.p === p) recCache = null; });
    return p;
  };

  // Full analytics (by day/week/month/IV/gate/exit, exit what-if grid, average PnL curves) over closed
  // live paper runs.
  fastify.get('/analytics', auth, async () => {
    const records = await loadRecords();
    return { success: true, runs: records.length, analytics: buildAnalytics(records) };
  });

  // Every day a strategy did not trade, with the reasons seen, plus entries still waiting inside their window.
  fastify.get('/drops', auth, async (req) => {
    await ensureBotSchema();
    const { limit } = q<{ limit?: string }>(req);
    const r = await pool.query(
      `SELECT id, run_key, strategy, book, date_key, status, tags, created_at FROM bot_runs
        WHERE status IN ('skipped','failed') ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(Number(limit) || 40, 1), 200)],
    );
    return {
      success: true,
      waiting: botEngine.enabled ? botEngine.waitingEntries() : [],
      drops: r.rows.map((x: any) => ({
        id: x.id, runKey: x.run_key, strategy: x.strategy, book: x.book, dateKey: x.date_key, status: x.status, at: x.created_at,
        reason: x.tags?.reason ?? (x.tags?.blocked ? `risk guard blocked: ${x.tags.blocked.join('; ')}` : null),
        attempts: x.tags?.attempts ?? 1,
        reasonsSeen: x.tags?.reasonsSeen ?? [],
      })),
    };
  });

  // The best-performing strategy book among the live paper trades the bot actually took, with the reason.
  fastify.get('/top', auth, async () => {
    const label = (key: string) => {
      const [s, b] = key.split('|');
      return (STRATEGY_NAMES[s!] ?? s) + (b ? ` (${b} book)` : '');
    };
    const live = buildAnalytics(await loadRecords()).byStrategy;
    return {
      success: true,
      live: pickTop(live, { label }),
    };
  });

  // Auto-learn: the rules in use, what was last tried, every promotion, and the bars a challenger must clear.
  fastify.get('/learn', auth, async () => {
    await ensureBotSchema();
    const params: Record<string, unknown> = {};
    for (const s of LEARNED_STRATEGIES) params[s] = await getParams(s);
    const [latest, log] = await Promise.all([
      pool.query(
        `SELECT DISTINCT ON (strategy) strategy, at, reason, evidence FROM bot_learning WHERE kind = 'evaluation' ORDER BY strategy, at DESC, id DESC`,
      ),
      pool.query(`SELECT at, strategy, kind, from_params, to_params, reason FROM bot_learning WHERE kind <> 'evaluation' ORDER BY at DESC, id DESC LIMIT 30`),
    ]);
    return { success: true, auto: autoLearnOn(), defaults: DEFAULT_PARAMS, thresholds: DEFAULT_THRESHOLDS, params, latest: latest.rows, log: log.rows };
  });

  // Run the review now. `?dry=1` evaluates without promoting.
  fastify.post('/learn/run', { preHandler: requireAdmin }, async (req) => {
    await ensureBotSchema();
    const dry = q<{ dry?: string }>(req).dry === '1';
    const reports = await runLearning(Date.now(), autoLearnOn() && !dry);
    return { success: true, reports: reports.map((r) => ({ strategy: r.strategy, days: r.days, promoted: r.promoted, note: r.note, champion: r.champion })) };
  });

  fastify.post('/learn/rollback', { preHandler: requireAdmin }, async (req, reply) => {
    const s = (req.body as { strategy?: string } | undefined)?.strategy;
    if (!s || !(LEARNED_STRATEGIES as readonly string[]).includes(s)) return bad(reply, `strategy must be one of ${LEARNED_STRATEGIES.join(', ')}`);
    const r = await rollbackLast(s);
    if (!r) return reply.code(404).send({ success: false, error: 'nothing to roll back: that strategy has not been changed by auto-learn' });
    return { success: true, restored: r.restored };
  });

  fastify.post('/pause', { preHandler: requireAdmin }, async () => {
    await setConfig({ paused: true });
    return { success: true, paused: true };
  });
  fastify.post('/resume', { preHandler: requireAdmin }, async () => {
    await setConfig({ paused: false });
    return { success: true, paused: false };
  });
  fastify.post('/kill', { preHandler: requireAdmin }, async () => {
    await setConfig({ killSwitch: true, paused: true });
    return { success: true, killSwitch: true };
  });
  fastify.post('/kill/reset', { preHandler: requireAdmin }, async () => {
    await setConfig({ killSwitch: false });
    return { success: true, killSwitch: false };
  });

};
