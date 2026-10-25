import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { paperTerminal } from '../services/paper/paper-terminal.js';
import { getOptionFlow } from '../services/paper/flow.js';

/**
 * The Paper Trade terminal's API. The account is fake money against real Delta order books; there is no
 * route (and no code anywhere in the paper module) that can place an order on a real exchange.
 */
const symbol = z.string().trim().regex(/^[A-Za-z0-9-]{3,40}$/, 'invalid contract symbol');
const price = z.number().positive().max(10_000_000);

export const orderBody = z.object({
  symbol,
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop_market']),
  lots: z.number().int().min(1).max(1_000_000),
  price: price.optional(),
  stopPrice: price.optional(),
  reduceOnly: z.boolean().optional(),
  leverage: z.number().int().min(1).max(500).optional(),
  takeProfit: price.optional(),
  stopLoss: price.optional(),
});

export const strategyBody = z.object({
  legs: z.array(z.object({ symbol, side: z.enum(['buy', 'sell']), lots: z.number().int().min(1).max(1_000_000), stop: price.nullable().optional() })).min(1).max(8),
  name: z.string().trim().max(120).optional(),
});

export const paperRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };
  const limited = { ...auth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: string) => reply.code(400).send({ success: false, error });
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) =>
    reply.code(502).send({ success: false, error: `market data unavailable: ${(e as Error).message}` });

  fastify.get('/account', auth, async (_req, reply) => {
    try {
      return { success: true, ...(await paperTerminal.account()) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // The option board for one expiry, strike by strike with calls and puts side by side.
  fastify.get('/board', auth, async (req, reply) => {
    try {
      const query = req.query as { expiry?: string; lots?: string };
      const lots = Math.min(Math.max(Math.floor(Number(query.lots)) || 100, 1), 100_000);
      const { snap, rows, mode, available } = await paperTerminal.boardWithMargin(lots);
      const wanted = Number(query.expiry);
      const expiry = snap.expiries.includes(wanted) ? wanted : snap.expiries[0] ?? null;
      const byStrike = new Map<number, { strike: number; call: unknown; put: unknown }>();
      for (const r of rows) {
        if (r.expiryMs !== expiry) continue;
        const e = byStrike.get(r.strike) ?? byStrike.set(r.strike, { strike: r.strike, call: null, put: null }).get(r.strike)!;
        if (r.type === 'call') e.call = r;
        else e.put = r;
      }
      const perp = snap.insts.get(snap.perp.symbol)!;
      return {
        success: true, spot: snap.spot, perp: snap.perp, perpInfo: { contractValue: perp.contractValue, maxLeverage: perp.maxLeverage, tick: perp.tick, takerRate: perp.takerRate, makerRate: perp.makerRate },
        expiries: snap.expiries, expiry, strikes: [...byStrike.values()].sort((a, b) => a.strike - b.strike), at: snap.at, lots, marginMode: mode, available,
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Option flow for the Strategy builder: what traders bought and sold, by window and by strike.
  fastify.get('/flow', auth, async () => ({ success: true, ...(await getOptionFlow()) }));

  fastify.get('/book', auth, async (req, reply) => {
    const s = symbol.safeParse((req.query as { symbol?: string }).symbol);
    if (!s.success) return bad(reply, 'symbol is required');
    try {
      const b = await paperTerminal.book(s.data);
      return { success: true, symbol: s.data, bids: b.bids.slice(0, 12), asks: b.asks.slice(0, 12) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  fastify.post('/preview', limited, async (req, reply) => {
    const b = orderBody.safeParse(req.body);
    if (!b.success) return bad(reply, b.error.issues[0]?.message ?? 'invalid order');
    try {
      return { success: true, preview: await paperTerminal.preview(b.data) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  fastify.post('/orders', limited, async (req, reply) => {
    const b = orderBody.safeParse(req.body);
    if (!b.success) return bad(reply, b.error.issues[0]?.message ?? 'invalid order');
    try {
      const r = await paperTerminal.place(b.data);
      return { success: true, order: r.order, children: r.children };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Multi-leg strategies from the builder: estimate, then place every leg together or none.
  fastify.post('/strategy/preview', limited, async (req, reply) => {
    const b = strategyBody.safeParse(req.body);
    if (!b.success) return bad(reply, b.error.issues[0]?.message ?? 'invalid strategy');
    try {
      return { success: true, preview: await paperTerminal.previewBasket(b.data.legs) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  fastify.post('/strategy', limited, async (req, reply) => {
    const b = strategyBody.safeParse(req.body);
    if (!b.success) return bad(reply, b.error.issues[0]?.message ?? 'invalid strategy');
    try {
      const r = await paperTerminal.placeBasket(b.data.legs, b.data.name);
      return r.ok ? { success: true, ...r } : reply.code(400).send({ success: false, error: r.reason });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Executed strategies: net PnL, each leg's PnL and stop, and the controls to edit stops or close everything.
  fastify.get('/strategies', auth, async (_req, reply) => {
    try {
      return { success: true, ...(await paperTerminal.strategies()) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  fastify.post('/strategy/:id/close', limited, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(reply, 'invalid strategy id');
    try {
      const r = await paperTerminal.closeStrategy(id);
      return r.ok ? { success: true } : reply.code(400).send({ success: false, error: r.reason });
    } catch (e) {
      return fail(reply, e);
    }
  });

  fastify.post('/strategy/:id/stops', limited, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(reply, 'invalid strategy id');
    const b = z.object({ stops: z.array(z.object({ symbol, stop: price.nullable() })).min(1).max(8) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error.issues[0]?.message ?? 'invalid stops');
    const r = await paperTerminal.setStops(id, b.data.stops);
    return r.ok ? { success: true } : reply.code(400).send({ success: false, error: r.reason });
  });

  // Portfolio margin or standard margin, like the margin-mode switch on Delta.
  fastify.post('/margin-mode', auth, async (req, reply) => {
    const b = z.object({ mode: z.enum(['portfolio', 'standard']) }).safeParse(req.body);
    if (!b.success) return bad(reply, 'mode must be portfolio or standard');
    const r = await paperTerminal.setMarginMode(b.data.mode);
    return r.ok ? { success: true, mode: b.data.mode } : reply.code(400).send({ success: false, error: r.reason });
  });

  fastify.delete('/orders/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return bad(reply, 'invalid order id');
    const ok = await paperTerminal.cancel(id);
    return ok ? { success: true } : reply.code(404).send({ success: false, error: 'no working order with that id' });
  });

  fastify.post('/orders/cancel-all', auth, async () => ({ success: true, cancelled: await paperTerminal.cancelAll() }));

  fastify.get('/orders', auth, async (req) => {
    const { status, limit } = req.query as { status?: string; limit?: string };
    const st = ['working', 'filled', 'cancelled', 'rejected'].includes(status ?? '') ? status! : null;
    return { success: true, orders: await paperTerminal.orders(st, Math.min(Math.max(Number(limit) || 50, 1), 300)) };
  });

  fastify.get('/fills', auth, async (req) => {
    const { limit } = req.query as { limit?: string };
    return { success: true, fills: await paperTerminal.fills(Math.min(Math.max(Number(limit) || 50, 1), 300)) };
  });

  fastify.post('/leverage', auth, async (req, reply) => {
    const b = z.object({ symbol, leverage: z.number().int().min(1).max(500) }).safeParse(req.body);
    if (!b.success) return bad(reply, b.error.issues[0]?.message ?? 'invalid leverage');
    try {
      const r = await paperTerminal.setLeverage(b.data.symbol, b.data.leverage);
      return r.ok ? { success: true } : reply.code(400).send({ success: false, error: r.reason });
    } catch (e) {
      return fail(reply, e);
    }
  });

  // Start over with a new balance. Needs the word RESET so it cannot happen by a stray click.
  fastify.post('/reset', auth, async (req, reply) => {
    const b = z.object({ balance: z.number().min(100).max(10_000_000), confirm: z.literal('RESET') }).safeParse(req.body);
    if (!b.success) return bad(reply, 'send { balance: 100 to 10,000,000, confirm: "RESET" }');
    await paperTerminal.reset(b.data.balance);
    return { success: true };
  });
};
