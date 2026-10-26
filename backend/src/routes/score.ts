import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/index.js';
import { userId } from '../lib/guards.js';
import { istDateKey } from '../lib/bot/schedule.js';
import { STRATEGY_NAMES } from '../lib/ask/parse.js';
import { ensureBotSchema } from '../services/bot/bot-store.js';
import { ensureAlgoSchema } from '../services/algo/algo-store.js';
import { paperFor } from '../services/paper/paper-terminal.js';

/**
 * The scoreboard's data: every finished trade of one source (the paper bot, the Algo panel, or your Paper Trade strategies) as a flat list.
 * The page groups them by strategy, then by weekday, then by day. No judgement is made here: these are the recorded results.
 */
export interface ScoreTrade {
  id: string;
  /** Group key: the bot's strategy id, the Algo rule name, or the Paper structure (Short strangle ...). */
  strategy: string;
  label: string;
  /** IST date the trade was entered, YYYY-MM-DD. */
  dateKey: string;
  entryMs: number;
  exitMs: number | null;
  net: number;
}

export type PaperLeg = { symbol: string; side: 'buy' | 'sell'; lots: number };

/** A readable structure name for a Paper strategy, from its legs. */
export function classifyPaperLegs(legs: readonly PaperLeg[]): { key: string; label: string } {
  const opt = legs.filter((l) => /^[CP]-BTC-/.test(l.symbol));
  const perp = legs.filter((l) => !/^[CP]-BTC-/.test(l.symbol));
  const mk = (label: string) => ({ key: label.toUpperCase().replace(/[^A-Z]+/g, '_'), label });
  if (!opt.length && perp.length === 1) return mk(perp[0]!.side === 'buy' ? 'BTC futures long' : 'BTC futures short');
  if (!opt.length || perp.length) return mk('Mixed or other');
  const strike = (s: string) => Number(s.split('-')[2]);
  const type = (s: string) => s[0];
  if (opt.length === 1) return mk(`${opt[0]!.side === 'sell' ? 'Short' : 'Long'} single ${type(opt[0]!.symbol) === 'C' ? 'call' : 'put'}`);
  if (opt.length === 2) {
    const [a, b] = opt as [PaperLeg, PaperLeg];
    const bothSell = a.side === 'sell' && b.side === 'sell', bothBuy = a.side === 'buy' && b.side === 'buy';
    if ((bothSell || bothBuy) && type(a.symbol) !== type(b.symbol)) {
      const same = strike(a.symbol) === strike(b.symbol);
      return mk(`${bothSell ? 'Short' : 'Long'} ${same ? 'straddle' : 'strangle'}`);
    }
  }
  if (opt.length === 4) return mk('Four-leg spread');
  return mk('Mixed or other');
}

const sourceQ = z.object({ source: z.enum(['bot', 'algo', 'paper']), book: z.enum(['always', 'gated']).optional(), limit: z.coerce.number().int().min(1).max(5000).optional() });

export const scoreRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };

  fastify.get('/trades', auth, async (req, reply) => {
    const q = sourceQ.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ success: false, error: 'source must be bot, algo or paper' });
    const { source, limit } = q.data, lim = limit ?? 2000, uid = userId(req);
    let trades: ScoreTrade[] = [];

    if (source === 'bot') {
      await ensureBotSchema();
      // the always book is every trade the bot took; the gated book repeats the same trades only on GO days
      const book = q.data.book ?? 'always';
      const r = await pool.query(
        `SELECT id, strategy, date_key, entry_at, exit_at, net_pnl FROM bot_runs
          WHERE status = 'closed' AND net_pnl IS NOT NULL AND entry_at IS NOT NULL AND book = $1 ORDER BY entry_at DESC LIMIT $2`,
        [book, lim],
      );
      trades = (r.rows as any[]).map((x) => ({
        id: x.id, strategy: x.strategy, label: STRATEGY_NAMES[x.strategy as string] ?? String(x.strategy), dateKey: String(x.date_key), entryMs: new Date(x.entry_at).getTime(),
        exitMs: x.exit_at ? new Date(x.exit_at).getTime() : null, net: Number(x.net_pnl),
      }));
    } else if (source === 'algo') {
      await ensureAlgoSchema();
      const r = await pool.query(
        `SELECT id, name, plan, entered_at, exited_at, net_pnl FROM algo_runs
          WHERE user_id = $1 AND status = 'exited' AND net_pnl IS NOT NULL AND entered_at IS NOT NULL ORDER BY entered_at DESC LIMIT $2`,
        [uid, lim],
      );
      trades = (r.rows as any[]).map((x) => {
        const ruleName = String(x.plan?.rule?.name ?? x.name);
        const entry = new Date(x.entered_at).getTime();
        return { id: x.id, strategy: ruleName, label: ruleName, dateKey: istDateKey(entry), entryMs: entry, exitMs: x.exited_at ? new Date(x.exited_at).getTime() : null, net: Number(x.net_pnl) };
      });
    } else {
      const s = await paperFor(uid).strategies(Math.min(lim, 1000));
      trades = s.closed.filter((x) => x.netPnl != null).map((x) => {
        const c = classifyPaperLegs(x.legs.map((l) => ({ symbol: l.symbol, side: l.side, lots: l.lots })));
        return { id: x.id, strategy: c.key, label: c.label, dateKey: istDateKey(x.openedAt), entryMs: x.openedAt, exitMs: x.closedAt, net: x.netPnl as number };
      });
    }
    return { success: true, source, trades };
  });
};
