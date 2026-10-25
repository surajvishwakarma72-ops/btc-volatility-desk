import type { FastifyPluginAsync } from 'fastify';
import { pool } from '../db/index.js';
import { istDateKey, istMidnightMs } from '../lib/bot/schedule.js';
import { botEngine } from '../services/bot/bot-engine.js';
import { ensureBotSchema, getConfig, setConfig } from '../services/bot/bot-store.js';

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
      `SELECT * FROM bot_runs WHERE ($1::text IS NULL OR strategy=$1) AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3`,
      [strategy ?? null, status ?? null, n],
    );
    return { success: true, runs: r.rows };
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
      legs: legs.rows,
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

  fastify.post('/pause', auth, async () => {
    await setConfig({ paused: true });
    return { success: true, paused: true };
  });
  fastify.post('/resume', auth, async () => {
    await setConfig({ paused: false });
    return { success: true, paused: false };
  });
  fastify.post('/kill', auth, async () => {
    await setConfig({ killSwitch: true, paused: true });
    return { success: true, killSwitch: true };
  });
  fastify.post('/kill/reset', auth, async () => {
    await setConfig({ killSwitch: false });
    return { success: true, killSwitch: false };
  });

};
