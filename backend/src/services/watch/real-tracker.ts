import { randomUUID } from 'node:crypto';
import { pool } from '../../db/index.js';
import { ensureAlgoSchema, openRuns, recordMark } from '../algo/algo-store.js';
import { expiryOf, type OptionPosition } from './live-exit.js';

/**
 * Live PnL of the real Delta positions the desk did not open itself (your own trades on the main account, or on the sub-account), so the
 * PnL analysis panel shows and records them minute by minute like an algo run. One run per account and expiry: it opens when a position
 * appears, gets a mark every minute while it is open, and closes with its last recorded PnL when the position is gone.
 * Positions that belong to an open algo run are left out (that run already tracks them), and a new position must be seen for 30 s first
 * so an algo entry that is still being recorded is not picked up twice.
 */
const LOT_BTC = 0.001, SETTLE_MS = 30_000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const expiryName = (e: string): string => (/^\d{6}$/.test(e) ? `${Number(e.slice(0, 2))} ${MON[Number(e.slice(2, 4)) - 1] ?? ''}` : e);
const ACCOUNT_NAME: Record<string, string> = { main: 'Main account', sub: 'Sub-account', account: 'Delta account' };

export const legPnl = (p: OptionPosition, mark: number): number => (p.size < 0 ? p.entry - mark : mark - p.entry) * Math.abs(p.size) * LOT_BTC;

const firstSeen = new Map<string, number>();

async function algoSymbols(userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of await openRuns().catch(() => [])) {
    if (r.userId !== userId || r.mode !== 'live' || !r.ref) continue;
    try { for (const s of (JSON.parse(r.ref) as { symbols?: string[] }).symbols ?? []) out.add(s); } catch { /* a reference that is not ours */ }
  }
  return out;
}

/**
 * Called with one account's current option positions (all of them, as read from Delta) and the mark of each contract.
 * Throws nothing the caller needs to handle; a failed write is skipped and retried on the next call.
 */
export async function observeReal(userId: string, account: string, positions: readonly OptionPosition[], markOf: (symbol: string) => number | null, now = Date.now()): Promise<void> {
  try {
    await ensureAlgoSchema();
    const skip = await algoSymbols(userId);
    const byExpiry = new Map<string, OptionPosition[]>();
    for (const p of positions) if (!skip.has(p.symbol)) (byExpiry.get(expiryOf(p.symbol)) ?? byExpiry.set(expiryOf(p.symbol), []).get(expiryOf(p.symbol))!).push(p);

    const open = (await pool.query(`SELECT id, expiry FROM real_runs WHERE user_id = $1 AND account = $2 AND status = 'open'`, [userId, account])).rows as Array<{ id: string; expiry: string }>;
    const openBy = new Map(open.map((r) => [r.expiry, r.id]));

    for (const [expiry, list] of byExpiry) {
      const fk = `${userId}|${account}|${expiry}`;
      let id = openBy.get(expiry);
      if (!id) {
        const seen = firstSeen.get(fk) ?? now;
        firstSeen.set(fk, seen);
        if (now - seen < SETTLE_MS) continue;
        id = randomUUID();
        await pool.query(
          'INSERT INTO real_runs (id, user_id, account, expiry, name, symbols, entered_at) VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7::double precision / 1000.0))',
          [id, userId, account, expiry, `${ACCOUNT_NAME[account] ?? account} · ${expiryName(expiry)} expiry`, JSON.stringify(list.map((p) => p.symbol)), seen],
        );
      }
      const marks = list.map((p) => markOf(p.symbol));
      if (marks.every((m): m is number => m != null && m > 0)) {
        const net = list.reduce((s, p, i) => s + legPnl(p, marks[i]!), 0);
        await recordMark(id, now, net, null);
      }
    }
    for (const fk of [...firstSeen.keys()]) { const [, a, e] = fk.split('|'); if (fk.startsWith(userId + '|') && a === account && !byExpiry.has(e!)) firstSeen.delete(fk); }

    // positions that are gone: close the run on its last recorded PnL
    for (const r of open) {
      if (byExpiry.has(r.expiry)) continue;
      await pool.query(
        `UPDATE real_runs SET status = 'closed', exited_at = now(), net_pnl = (SELECT net FROM algo_run_marks WHERE run_id = $1 ORDER BY t DESC LIMIT 1) WHERE id = $1`,
        [r.id],
      );
    }
  } catch { /* tracking must never disturb the alarm; the next call tries again */ }
}
