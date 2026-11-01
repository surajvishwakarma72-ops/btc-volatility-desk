import { pool } from '../db/index.js';
import { ledger, parseDeltaFill, positionDiffs, type FillRow } from '../lib/fills-pnl.js';
import { deltaSignedGet } from '../routes/delta.js';
import { ensureFillsSchema } from '../routes/fills.js';
import { accountReader, type AccountState } from './account-state.js';
import { watchedAccounts, type DeskAccount } from './accounts.js';
import { ensureAlgoSchema } from './algo/algo-store.js';
import { DESK_USER_ID } from './auth-store.js';
import { parseExpiry } from './bot/delta-public.js';
import { usersWithDeltaKey } from './delta-keys.js';
import { broadcastFill } from './desk-events.js';
import { reconcileStatus, setReconcileStatus } from './reconcile-state.js';

/**
 * Copies each account's Delta fills to the server, so P&L no longer depends on an open browser. Read-only: it calls only GET /v2/fills.
 * Realised P&L per fill comes from lib/fills-pnl.ts, and closed real runs take their final P&L from these fills instead of the last mark.
 */
const EVERY_MS = 60_000;
const FIRST_LOOK_MS = 30 * 86_400_000;
const OVERLAP_MS = 3_600_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const NEW_FILL_MS = 5 * 60_000;

type SignedGet = (key: string, secret: string, path: string, query: string) => Promise<{ ok: boolean; status: number; body: unknown; errorText: string }>;

export interface FillsSyncDeps {
  users(): Promise<string[]>;
  accounts(userId: string): Promise<DeskAccount[]>;
  positions(userId: string): Promise<AccountState[]>;
  get: SignedGet;
  now(): number;
}

async function latestFill(userId: string, account: string): Promise<number | null> {
  const r = await pool.query('SELECT max(filled_at) AS at FROM fills WHERE user_id = $1 AND account_kind = $2', [userId, account]);
  const at = (r.rows[0] as { at: string | Date | null } | undefined)?.at;
  return at ? new Date(at).getTime() : null;
}

async function saveFill(userId: string, account: string, f: FillRow): Promise<Record<string, unknown> | null> {
  const r = await pool.query(
    `INSERT INTO fills (exchange_fill_id, account_kind, user_id, instrument, symbol, side, qty, price, fee, liquidity, filled_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (account_kind, exchange_fill_id) DO NOTHING RETURNING id, account_kind, user_id, symbol, side, qty, price, filled_at`,
    [f.exchangeFillId, account, userId, f.instrument, f.symbol, f.side, f.qty, f.price, f.fee, f.liquidity, f.filledAt, JSON.stringify(f.raw)],
  );
  return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function accountFills(userId: string, account: string): Promise<Array<FillRow & { totalPnl: number | null }>> {
  const r = await pool.query('SELECT raw, total_pnl FROM fills WHERE user_id = $1 AND account_kind = $2 AND raw IS NOT NULL ORDER BY filled_at, exchange_fill_id', [userId, account]);
  return (r.rows as Array<{ raw: unknown; total_pnl: string | null }>).flatMap((row) => {
    const raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
    const f = parseDeltaFill(raw);
    return f ? [{ ...f, totalPnl: row.total_pnl == null ? null : Number(row.total_pnl) }] : [];
  });
}

/** Sets the final P&L of closed real runs from their fills. A run keeps its last mark until both sides of the trade are stored and priced. */
async function settleClosedRuns(userId: string, account: string): Promise<void> {
  await ensureAlgoSchema();
  const runs = await pool.query(
    `SELECT id, expiry, entered_at, exited_at FROM real_runs
     WHERE user_id = $1 AND account = $2 AND status = 'closed' AND pnl_source IS NULL AND exited_at > now() - interval '7 days'`,
    [userId, account],
  );
  for (const run of runs.rows as Array<{ id: string; expiry: string; entered_at: string | Date; exited_at: string | Date }>) {
    const s = (await pool.query(
      `SELECT count(*)::int AS n, count(total_pnl)::int AS priced, count(DISTINCT side)::int AS sides, sum(total_pnl) AS net FROM fills
       WHERE user_id = $1 AND account_kind = $2 AND symbol LIKE $3 AND filled_at BETWEEN $4::timestamptz - interval '10 minutes' AND $5::timestamptz + interval '5 minutes'`,
      [userId, account, `%-${run.expiry}`, new Date(run.entered_at).toISOString(), new Date(run.exited_at).toISOString()],
    )).rows[0] as { n: number; priced: number; sides: number; net: string | null };
    if (s.n > 0 && s.sides === 2 && s.priced === s.n) {
      await pool.query(`UPDATE real_runs SET net_pnl = $2, pnl_source = 'fills' WHERE id = $1`, [run.id, s.net]);
    }
  }
}

export class FillsSync {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Symbols that disagreed last time. A position read can lag by up to 10 s, so one miss alone is not reported. */
  private lastDiff = new Map<string, string>();

  constructor(private deps: FillsSyncDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), EVERY_MS);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await ensureFillsSchema();
      for (const userId of await this.deps.users()) {
        const accounts = await this.deps.accounts(userId).catch(() => []);
        if (!accounts.length) continue;
        const states = await this.deps.positions(userId).catch(() => [] as AccountState[]);
        for (const a of accounts) {
          await this.syncAccount(userId, a, states.find((s) => s.account === a.account) ?? null)
            .catch((e) => console.warn(`[fills-sync] ${a.account}:`, e instanceof Error ? e.message : e));
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async syncAccount(userId: string, a: DeskAccount, state: AccountState | null): Promise<void> {
    const now = this.deps.now();
    const latest = await latestFill(userId, a.account);
    const fromMs = latest == null ? now - FIRST_LOOK_MS : latest - OVERLAP_MS;
    let added = 0;
    let after: string | null | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = `page_size=${PAGE_SIZE}&start_time=${fromMs * 1000}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const r = await this.deps.get(a.creds.key, a.creds.secret, '/v2/fills', query);
      if (!r.ok) throw new Error(`fills read refused (${r.errorText || r.status})`);
      const body = r.body as { result?: unknown[]; meta?: { after?: string | null } };
      for (const raw of body.result ?? []) {
        const f = parseDeltaFill(raw);
        if (!f) continue;
        const row = await saveFill(userId, a.account, f);
        if (!row) continue;
        added += 1;
        if (now - Date.parse(f.filledAt) < NEW_FILL_MS) broadcastFill(row);
      }
      after = body.meta?.after;
      if (!after) break;
    }

    const fills = await accountFills(userId, a.account);
    const { pnl, open } = ledger(fills);
    if (added > 0) {
      for (const f of fills) {
        const v = pnl.get(f.exchangeFillId) ?? null;
        if (v !== f.totalPnl) {
          await pool.query('UPDATE fills SET total_pnl = $3, other_pnl = $3 WHERE account_kind = $1 AND exchange_fill_id = $2', [a.account, f.exchangeFillId, v]);
        }
      }
    }
    await settleClosedRuns(userId, a.account);
    if (state?.positions) this.reconcile(userId, a.account, open, state.positions, now);
  }

  /** Compares live option positions with what the fills add up to. Contracts past expiry leave the exchange's list without always leaving a fill. */
  private reconcile(userId: string, account: string, fromFills: ReadonlyMap<string, number>, positions: unknown[], now: number): void {
    const live = (symbol: string): boolean => /^[CP]-/.test(symbol) && (parseExpiry(symbol) ?? 0) > now;
    const exchange = new Map<string, number>();
    for (const p of positions as Array<{ product_symbol?: string; size?: unknown }>) {
      const size = Number(p.size);
      if (p.product_symbol && size !== 0 && live(p.product_symbol)) exchange.set(p.product_symbol, size);
    }
    const diffs = positionDiffs(new Map([...fromFills].filter(([s]) => live(s))), exchange);
    const id = `${userId}|${account}`;
    const signature = diffs.join(',');
    const confirmed = diffs.length > 0 && this.lastDiff.get(id) === signature;
    this.lastDiff.set(id, signature);
    if (diffs.length > 0 && !confirmed && reconcileStatus(userId, account)?.state !== 'mismatch') return;
    setReconcileStatus(userId, account, { state: confirmed ? 'mismatch' : 'ok', symbols: confirmed ? diffs : [], checkedAt: now });
  }
}

export const fillsSync = new FillsSync({
  users: async () => [...new Set([DESK_USER_ID, ...(await usersWithDeltaKey().catch(() => []))])],
  accounts: watchedAccounts,
  positions: (userId) => accountReader.read(userId),
  get: (key, secret, path, query) => deltaSignedGet(key, secret, path, query),
  now: () => Date.now(),
});
