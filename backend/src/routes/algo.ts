import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { userId } from '../lib/guards.js';
import { defaultStrangle, exitAtMs, exitSchema, strategySchema, type AlgoStrategy } from '../lib/algo/rule.js';
import { istDateKey } from '../lib/bot/schedule.js';
import { algoEngine, loadMarket } from '../services/algo/algo-runtime.js';
import { chooseExpiries, expiryCodeOf } from '../lib/algo/plan.js';
import { conditionsOf } from '../services/algo/algo-engine.js';
import { clearPending, createRun, deleteStrategy, finishRun, getAlgoDescription, getDefaults, getMarks, getRunById, getStrategy, listStrategies, recentRuns, saveAlgoDescription, saveDefaults, saveStrategy, setArmed } from '../services/algo/algo-store.js';
import { enterNow, exitAll, liveState, marketReport, previewEntry } from '../services/algo/algo-service.js';
import { loadInsights, ownRunStats } from '../services/algo/insights-service.js';
import { paperBroker } from '../services/algo/brokers.js';
import { liveBroker } from '../services/algo/live-entry.js';
import { fetchOptionPositions, OPTION_SYMBOL } from '../services/watch/live-exit.js';
import { loadDeltaKey } from '../services/delta-keys.js';
import { paperFor } from '../services/paper/paper-terminal.js';
import { getWatchConfig, recentWatchEvents } from '../services/watch/watch-store.js';
import { liveChecklist, logRuleBreak } from '../services/rulebook/rulebook-service.js';

/**
 * The Algo panel's API. Strategies run on the user's own Paper account unless the strategy is switched to Live, and Live needs
 * a saved trading key; real orders also need the arm / dry-run / server switches in services/watch (see live-entry.ts).
 */
const lotsField = z.number().int().min(1).max(1_000_000);
const strategyBody = z.object({ id: z.string().uuid().optional(), rule: strategySchema, lots: lotsField });

export const algoRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };
  const limited = { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  const bad = (reply: any, error: string, code = 400) => reply.code(code).send({ success: false, error });
  const need = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

  fastify.get('/state', auth, async (req) => {
    const uid = userId(req);
    const [strategies, runs, live, defaults, wc] = await Promise.all([listStrategies(uid), recentRuns(uid, 40), liveState(uid), getDefaults(uid), getWatchConfig(uid)]);
    // open runs get their current net PnL
    const open = runs.filter((r) => r.status === 'entered' && r.ref);
    const net = new Map<string, number | null>();
    const legsNow = new Map<string, unknown>();
    await Promise.all(open.map(async (r) => {
      const s = await (r.mode === 'live' ? liveBroker : paperBroker).status(uid, r.ref!).catch(() => null);
      net.set(r.id, s?.netPnl ?? null);
      legsNow.set(r.id, s?.legs ?? []);
    }));
    return {
      success: true, live, defaults, now: Date.now(),
      // the stop alarm and hard exit distances that really apply (Settings), so the page can say them truthfully
      watch: { warnPoints: wc.warnPoints, hardPoints: wc.hardPoints, liveArmed: wc.liveArmed, dryRun: wc.dryRun },
      strategies: strategies.map((s) => ({ id: s.id, rule: s.rule, lots: s.lots, armed: s.armed, check: algoEngine.checks.get(s.id) ?? null })),
      runs: runs.map((r) => ({ ...r, liveNetPnl: net.get(r.id) ?? null, liveLegs: legsNow.get(r.id) ?? [] })),
      engineError: algoEngine.errors.get(uid) ?? null,
    };
  });

  fastify.get('/events', auth, async (req) => ({ success: true, events: (await recentWatchEvents(userId(req), 60)).filter((e) => e.kind.startsWith('algo_')) }));

  fastify.post('/strategies', limited, async (req, reply) => {
    const b = strategyBody.safeParse(req.body);
    if (!b.success) return bad(reply, need(b.error));
    const uid = userId(req);
    if (b.data.rule.mode === 'live' && !(await liveState(uid)).tradeKey) return bad(reply, 'Live mode needs a trading key. Save one in Settings first, or keep this strategy on Paper.', 409);
    if (b.data.id && !(await getStrategy(uid, b.data.id))) return bad(reply, 'no such strategy', 404);
    return { success: true, strategy: await saveStrategy(uid, b.data.id ?? null, b.data.rule, b.data.lots) };
  });

  fastify.delete('/strategies/:id', limited, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    if (!id.success) return bad(reply, 'bad id');
    return (await deleteStrategy(userId(req), id.data)) ? { success: true } : bad(reply, 'no such strategy', 404);
  });

  fastify.post('/strategies/:id/arm', limited, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    const b = z.object({ armed: z.boolean() }).safeParse(req.body);
    if (!id.success || !b.success) return bad(reply, 'send { "armed": true | false }');
    const uid = userId(req);
    const s = await getStrategy(uid, id.data);
    if (!s) return bad(reply, 'no such strategy', 404);
    if (b.data.armed && s.rule.mode === 'live' && !(await liveState(uid)).tradeKey) return bad(reply, 'Live mode needs a trading key. Save one in Settings first.', 409);
    await setArmed(uid, id.data, b.data.armed);
    return { success: true, armed: b.data.armed };
  });

  // The summary the user reads before saying ok. Places nothing.
  fastify.post('/preview', limited, async (req, reply) => {
    const b = z.object({ rule: strategySchema, lots: lotsField, when: z.enum(['now', 'later']).optional() }).safeParse(req.body);
    if (!b.success) return bad(reply, need(b.error));
    try {
      const { plan, ...p } = await previewEntry(userId(req), b.data.rule, b.data.lots, b.data.when ?? 'now');
      void plan;
      return { success: true, preview: p };
    } catch (e) {
      return bad(reply, `market data unavailable: ${(e as Error).message}`, 502);
    }
  });

  // The option chain for the strike picker: every strike near the money of one expiry, with delta, gamma, IV, theta and the quotes.
  fastify.get('/chain', auth, async (req, reply) => {
    const q = z.object({ mode: z.enum(['current', 'next', 'n2n', 'fixed']).default('n2n'), code: z.string().regex(/^\d{6}$/).optional() }).safeParse(req.query);
    if (!q.success) return bad(reply, need(q.error));
    try {
      const m = await loadMarket(false);
      const ex = chooseExpiries({ mode: q.data.mode, code: q.data.code }, m.expiries, Date.now());
      if (typeof ex === 'string') return bad(reply, ex, 422);
      const e = ex[0]!;
      const fin = (v: number | undefined) => (v != null && Number.isFinite(v) ? v : null);
      const by = new Map<number, { strike: number; call: any; put: any }>();
      for (const o of m.chain.filter((x) => x.expiryMs === e)) {
        const row = by.get(o.strike) ?? { strike: o.strike, call: null, put: null };
        row[o.type] = { symbol: o.symbol, delta: o.delta, bid: o.bid, ask: o.ask, iv: fin(o.iv), gamma: fin(o.gamma), theta: fin(o.theta) };
        by.set(o.strike, row);
      }
      // only strikes a seller might use: some delta between 0.02 and 0.5 on either side
      const rows = [...by.values()].filter((r) => [r.call, r.put].some((s) => s && s.delta >= 0.02 && s.delta <= 0.5)).sort((a, b) => a.strike - b.strike);
      const atmK = [...by.keys()].reduce((b, k) => (Math.abs(k - m.spot) < Math.abs(b - m.spot) ? k : b), rows[0]?.strike ?? m.spot);
      const at = by.get(atmK);
      const mean = (xs: Array<number | null | undefined>) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
      return { success: true, expiry: expiryCodeOf(e), expiryMs: e, spot: m.spot, atm: { strike: atmK, iv: mean([at?.call?.iv, at?.put?.iv]), gamma: mean([at?.call?.gamma, at?.put?.gamma]) }, rows };
    } catch (err) {
      return bad(reply, `market data unavailable: ${(err as Error).message}`, 502);
    }
  });

  // Enter right now, outside the window (the panel's "Enter now"). Live mode still goes through every lock.
  fastify.post('/enter-now', limited, async (req, reply) => {
    const b = z.object({ rule: strategySchema, lots: lotsField, strategyId: z.string().uuid().optional(), override: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return bad(reply, need(b.error));
    const uid = userId(req);
    if (b.data.rule.mode === 'live' && !(await liveState(uid)).tradeKey) return bad(reply, 'Live mode needs a trading key.', 409);
    // Rule Book before-entry checklist: a red tick asks for a second confirmation, and placing anyway is logged as a rule break
    // (next trades at half size). A reached daily stop needs the typed unlock in the Rule Book, not a confirmation.
    let broken: string[] = [];
    if (b.data.rule.instrument === 'option') {
      const c = await liveChecklist(uid).catch(() => null);
      const red = c ? c.red : [{ id: 'data', label: 'Rule book unavailable', now: 'could not read the live checklist', rule: 'No entry on NO DATA.' }];
      if (c?.dailyStop.stopped) return reply.status(423).send({ success: false, code: 'DAILY_STOP', error: `Daily stop reached (${c.dailyStop.why}). Unlock it in the Rule Book to trade again today.` });
      if (red.length && !b.data.override) {
        return reply.status(409).send({ success: false, code: 'RULEBOOK_RED', error: `Rule book: ${red.length} red tick${red.length === 1 ? '' : 's'}`, red: red.map((x) => ({ label: x.label, now: x.now, rule: x.rule })) });
      }
      broken = red.map((x) => x.label);
    }
    try {
      const r = await enterNow(uid, b.data.rule, b.data.lots, b.data.strategyId ?? null);
      // a rule break counts only when a trade actually went in (a dry run sends nothing)
      if (r.ok && !r.dry && broken.length) await logRuleBreak(uid, broken, 'Entered with red ticks (Enter now)').catch(() => undefined);
      return r.ok ? { success: true, dry: r.dry, detail: r.detail, run: r.run } : bad(reply, r.reason, 422);
    } catch (e) {
      return bad(reply, (e as Error).message, 502);
    }
  });

  // "Market condition" in Ask me: the whole market read for a short strangle seller (trend, patterns, indicators, IV and gamma, verdict).
  fastify.get('/market-report', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (_req, reply) => {
    try {
      return { success: true, report: await marketReport() };
    } catch (e) {
      return bad(reply, `market data unavailable: ${(e as Error).message}`, 502);
    }
  });

  // Hard-kill every position. Real orders only when a trading key is saved and the locks allow it.
  fastify.post('/exit-all', limited, async (req, reply) => {
    try {
      await clearPending(userId(req));
      const scope = z.enum(['paper', 'live', 'both']).catch('both').parse((req.body as { scope?: unknown } | null)?.scope);
      return { success: true, ...(await exitAll(userId(req), scope)) };
    } catch (e) {
      return bad(reply, (e as Error).message, 502);
    }
  });

  
  // Algo Strategy Description (plain language documentation / configuration)
  const descBody = z.object({
    entryConditions: z.string().max(10_000).optional().default(''),
    holdConditions: z.string().max(10_000).optional().default(''),
    exitConditions: z.string().max(10_000).optional().default(''),
    riskManagement: z.string().max(10_000).optional().default(''),
    sessionTimingRules: z.string().max(10_000).optional().default(''),
    marketConditionsNotes: z.string().max(10_000).optional().default(''),
  });

  fastify.get('/description', auth, async (req) => {
    return { success: true, description: await getAlgoDescription(userId(req)) };
  });

  fastify.put('/description', limited, async (req, reply) => {
    const b = descBody.safeParse(req.body);
    if (!b.success) return bad(reply, need(b.error));
    const saved = await saveAlgoDescription(userId(req), b.data);
    return { success: true, description: saved };
  });

  fastify.get('/defaults', auth, async (req) => ({ success: true, defaults: (await getDefaults(userId(req))) ?? defaultStrangle() }));
  fastify.put('/defaults', limited, async (req, reply) => {
    const b = strategySchema.safeParse((req.body as { rule?: unknown } | null)?.rule);
    if (!b.success) return bad(reply, need(b.error));
    await saveDefaults(userId(req), b.data);
    return { success: true };
  });

  // PnL minute by minute for one run: the data behind the chart with the hairline.
  fastify.get('/runs/:id/pnl', auth, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    if (!id.success) return bad(reply, 'bad id');
    const uid = userId(req);
    const run = await getRunById(uid, id.data);
    if (!run) return bad(reply, 'no such run', 404);
    const m = await getMarks(run.id);
    let nowLegs: unknown[] = [];
    // an open run also gets the live point so the chart reaches "now"
    if (run.status === 'entered' && run.ref) {
      const st = await (run.mode === 'live' ? liveBroker : paperBroker).status(uid, run.ref).catch(() => null);
      nowLegs = st?.legs ?? [];
      if (st?.netPnl != null) { m.t.push(Date.now()); m.net.push(st.netPnl); m.spot.push(st.future?.mark ?? null); }
    }
    const rule = (run.plan as { rule?: { exit?: { netTargetUsd?: number | null; futTargetUsd?: number | null } } } | null)?.rule;
    let peak = null as { t: number; net: number } | null, trough = null as { t: number; net: number } | null;
    m.net.forEach((v, i) => { if (!peak || v > peak.net) peak = { t: m.t[i]!, net: v }; if (!trough || v < trough.net) trough = { t: m.t[i]!, net: v }; });
    return {
      success: true, t: m.t, net: m.net, gross: m.net, spot: m.spot, legs: [], nowLegs,
      tp: rule?.exit?.netTargetUsd ?? rule?.exit?.futTargetUsd ?? null, stats: { peak, trough },
      run: { id: run.id, name: run.name, status: run.status === 'entered' ? 'open' : 'closed', mode: run.mode, lots: run.lots, enteredAt: run.enteredAt, exitedAt: run.exitedAt, exitReason: run.exitReason, margin: null },
    };
  });

  // What has worked: indicators ranked on recent candles, and how your own finished runs did per condition.
  fastify.get('/insights', auth, async (req, reply) => {
    try {
      const [market, own] = await Promise.all([loadInsights(), ownRunStats(userId(req))]);
      return { success: true, market, own };
    } catch (e) {
      return bad(reply, `candles unavailable: ${(e as Error).message}`, 502);
    }
  });

  // Close one tracked run now (the panel's "Exit now").
  fastify.post('/runs/:id/exit', limited, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    if (!id.success) return bad(reply, 'bad id');
    const uid = userId(req);
    const run = await getRunById(uid, id.data);
    if (!run) return bad(reply, 'no such run', 404);
    if (run.status !== 'entered' || !run.ref) return bad(reply, 'that run is not open', 409);
    const broker = run.mode === 'live' ? liveBroker : paperBroker;
    const st = await broker.status(uid, run.ref).catch(() => null);
    const closed = await broker.closeAll(uid, run.ref, 'closed by you');
    if (!closed.ok) return bad(reply, closed.reason ?? 'could not close', 422);
    await finishRun(run.id, 'exited', 'closed by you', st?.netPnl ?? null);
    return { success: true };
  });

  // What can be adopted: open Paper strategies and, with a key saved, real Delta option contracts.
  fastify.get('/open-positions', auth, async (req) => {
    const uid = userId(req);
    const paper = (await paperFor(uid).strategies(0).catch(() => ({ open: [] as Array<{ id: string; name: string; netPnl: number | null; legs: unknown[] }> }))).open.map((s) => ({ id: s.id, name: s.name, netPnl: s.netPnl, legs: s.legs.length }));
    let delta: Array<{ symbol: string; size: number; entry: number }> = [];
    let deltaNote: string | null = null;
    const key = (await loadDeltaKey(uid, 'trade')) ?? (await loadDeltaKey(uid, 'read'));
    if (!key) deltaNote = 'Save a Delta key in Settings to see your real option positions here.';
    else {
      try { delta = (await fetchOptionPositions(key.key, key.secret)).map((p) => ({ symbol: p.symbol, size: p.size, entry: p.entry })); } catch (e) { deltaNote = (e as Error).message; }
    }
    return { success: true, paper, delta, deltaNote };
  });

  // What the voice assistant reads out. Unlike /open-positions it counts plain Paper orders, and a failed read is reported, never an empty list.
  fastify.get('/voice-positions', auth, async (req) => {
    const uid = userId(req);
    let paper: Array<{ id: string; name: string; netPnl: number | null; legs: number }> = [];
    let paperLoose = 0;
    let paperNote: string | null = null;
    try {
      const open = (await paperFor(uid).strategies(0)).open;
      paper = open.map((s) => ({ id: s.id, name: s.name, netPnl: s.netPnl, legs: s.legs.length }));
      const inStrategy = new Set(open.flatMap((s) => (s.legs as Array<{ symbol?: string }>).map((l) => l.symbol)));
      const acc = await paperFor(uid).account();
      if (acc.marketError) paperNote = acc.marketError;
      paperLoose = acc.positions.filter((p) => p.lots && !inStrategy.has(p.symbol)).length;
    } catch (e) { paperNote = (e as Error).message; }
    let delta: Array<{ symbol: string; size: number; entry: number }> = [];
    let deltaNote: string | null = null;
    const key = (await loadDeltaKey(uid, 'trade')) ?? (await loadDeltaKey(uid, 'read'));
    if (!key) deltaNote = 'No Delta key saved';
    else {
      try { delta = (await fetchOptionPositions(key.key, key.secret)).map((p) => ({ symbol: p.symbol, size: p.size, entry: p.entry })); } catch (e) { deltaNote = (e as Error).message; }
    }
    return { success: true, paper, paperLoose, paperNote, delta, deltaNote };
  });

  // Attach exit rules to a position that is already open (a Paper strategy, or real Delta option contracts).
  fastify.post('/adopt', limited, async (req, reply) => {
    const b = z.discriminatedUnion('source', [
      z.object({ source: z.literal('paper'), id: z.string().uuid(), exit: exitSchema, name: z.string().trim().max(80).optional() }),
      z.object({ source: z.literal('delta'), symbols: z.array(z.string().regex(OPTION_SYMBOL)).min(1).max(8), exit: exitSchema, name: z.string().trim().max(80).optional() }),
    ]).safeParse(req.body);
    if (!b.success) return bad(reply, need(b.error));
    const uid = userId(req);
    const now = Date.now();
    const rule: AlgoStrategy = { ...defaultStrangle(), name: b.data.name || 'Adopted position', mode: b.data.source === 'paper' ? 'paper' : 'live', exit: b.data.exit, entry: { kind: 'hard', time: '00:00' } };
    let ref: string;
    let name = rule.name;
    if (b.data.source === 'paper') {
      const wanted = b.data.id;
      const open = (await paperFor(uid).strategies(0)).open.find((s) => s.id === wanted);
      if (!open) return bad(reply, 'that strategy is not open on your Paper account', 404);
      ref = open.id;
      name = b.data.name || open.name;
    } else {
      if (!(await liveState(uid)).tradeKey) return bad(reply, 'Tracking real positions with exits needs a trading key.', 409);
      ref = JSON.stringify({ symbols: b.data.symbols });
    }
    const exitAt = exitAtMs(b.data.exit, { dateKey: istDateKey(now), startMs: now, endMs: now }, now);
    const run = await createRun({
      userId: uid, strategyId: null, name, dateKey: `adopt-${now}`, mode: rule.mode, status: 'entered', lots: 0, reason: 'adopted: an existing position now follows these exit rules',
      plan: { rule: { ...rule, name }, plan: null, why: 'adopted position' }, ref, windowStart: now, enteredAt: now, exitAt,
    });
    return { success: true, run, conditionsIgnored: conditionsOf(rule).length };
  });
};
