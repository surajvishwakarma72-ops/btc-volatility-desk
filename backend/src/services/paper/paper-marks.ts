import { pool } from '../../db/index.js';
import { activePaperIds, peekPaper } from './paper-terminal.js';

/**
 * Net PnL of every open Paper strategy, one sample a minute, so a finished strategy can be drawn minute by minute with a hairline.
 * Strategies that were closed before this existed simply have no minutes, and the page says so.
 */
let ready: Promise<void> | null = null;
export function ensurePaperMarksSchema(): Promise<void> {
  if (!ready) {
    ready = pool.query(`CREATE TABLE IF NOT EXISTS paper_strategy_marks (
      strategy_id uuid NOT NULL, t timestamptz NOT NULL, net numeric NOT NULL, PRIMARY KEY (strategy_id, t))`).then(() => undefined);
    ready.catch(() => { ready = null; });
  }
  return ready;
}

export async function recordPaperMark(strategyId: string, tMs: number, net: number): Promise<void> {
  await ensurePaperMarksSchema();
  const minute = Math.floor(tMs / 60_000) * 60_000;
  await pool.query('INSERT INTO paper_strategy_marks (strategy_id, t, net) VALUES ($1, to_timestamp($2::double precision / 1000.0), $3) ON CONFLICT DO NOTHING', [strategyId, minute, net]);
}

export async function getPaperMarks(strategyId: string): Promise<{ t: number[]; net: number[] }> {
  await ensurePaperMarksSchema();
  const r = await pool.query('SELECT t, net FROM paper_strategy_marks WHERE strategy_id = $1 ORDER BY t', [strategyId]);
  const rows = r.rows as Array<{ t: string; net: string }>;
  return { t: rows.map((x) => new Date(x.t).getTime()), net: rows.map((x) => Number(x.net)) };
}

/** One round: every active account's open strategies. Failures are skipped, the next minute tries again. */
export async function recordAllPaperMarks(now = Date.now()): Promise<number> {
  let n = 0;
  for (const id of activePaperIds()) {
    try {
      const s = await peekPaper(id)?.strategies(0);
      for (const st of s?.open ?? []) {
        if (st.netPnl != null) { await recordPaperMark(st.id, now, st.netPnl); n++; }
      }
    } catch { /* try again next minute */ }
  }
  return n;
}

let timer: NodeJS.Timeout | null = null;
export const paperMarks = {
  start() { if (!timer) { timer = setInterval(() => { void recordAllPaperMarks(); }, 60_000); timer.unref?.(); } },
  stop() { if (timer) clearInterval(timer); timer = null; },
};
