import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { DeskAccount } from './accounts.js';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function; close: Function } }));
vi.mock('../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) {
        const res = await h.db.exec(text);
        const last = res[res.length - 1];
        return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 };
      }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));

const { FillsSync } = await import('./fills-sync.js');
const { ensureFillsSchema, resetFillsSchemaCache } = await import('../routes/fills.js');
const { ensureAuthSchema, DESK_USER_ID } = await import('./auth-store.js');
const { ensureAlgoSchema } = await import('./algo/algo-store.js');
const { clearReconcileStatus, reconcileStatus } = await import('./reconcile-state.js');
const { deskEvents } = await import('./desk-events.js');
const { pool } = await import('../db/index.js');

const NOW = Date.UTC(2026, 10, 1, 6, 0, 0);
const SYM = 'C-BTC-90000-271126';
const main = { account: 'main' as const, kind: 'read' as const, creds: { key: 'K-MAIN', secret: 's' }, watchOnly: true };
const sub = { account: 'sub' as const, kind: 'trade' as const, creds: { key: 'K-SUB', secret: 's' }, watchOnly: false };
const fill = (id: number, side: string, price: number, t: string, over = {}) => ({ id, product_symbol: SYM, side, size: 5, price: String(price), commission: '0.05', role: 'taker', created_at: t, product: { contract_value: '0.001' }, ...over });
const state = (positions: unknown[] | null, account: 'main' | 'sub' = 'main') => ({ account, kind: 'read' as const, health: 'connected' as const, error: null, positions, lastOkAt: NOW, serverTs: NOW });

function sync(pages: Record<string, unknown[][]>, positions: unknown[] | null = [], accounts: DeskAccount[] = [main]) {
  const queries: string[] = [];
  const get = vi.fn(async (key: string, _s: string, path: string, query: string) => {
    expect(path).toBe('/v2/fills');
    queries.push(query);
    const list = pages[key] ?? [[]];
    const page = /after=p(\d)/.exec(query)?.[1];
    const i = page ? Number(page) : 0;
    return { ok: true, status: 200, errorText: '', body: { result: list[i] ?? [], meta: { after: i + 1 < list.length ? `p${i + 1}` : null } } };
  });
  return { s: new FillsSync({ users: async () => [DESK_USER_ID], accounts: async () => accounts, positions: async () => accounts.map((a) => state(positions, a.account as 'main')), get, now: () => NOW }), get, queries };
}

beforeAll(async () => {
  resetFillsSchemaCache();
  h.db = new PGlite() as never;
  await ensureAuthSchema();
  await ensureFillsSchema();
  await ensureAlgoSchema(); // no users row on purpose: the owner may log in with the server password and have none
}, 30000);
afterAll(async () => { await h.db.close(); });
beforeEach(async () => {
  await pool.query('DELETE FROM fills');
  await pool.query('DELETE FROM real_runs');
  clearReconcileStatus();
});

const rows = async () => (await pool.query('SELECT exchange_fill_id, account_kind, fee, total_pnl FROM fills ORDER BY filled_at', [])).rows as any[];

describe('FillsSync', () => {
  it('stores fills per account with real P&L', async () => {
    const { s } = sync({ 'K-MAIN': [[fill(1, 'sell', 135, '2026-10-28T19:00:00Z'), fill(2, 'buy', 98, '2026-10-29T01:00:00Z')]] });
    await s.runOnce();
    const [a, b] = await rows();
    expect(a).toMatchObject({ exchange_fill_id: '1', account_kind: 'main' });
    expect(Number(a.total_pnl)).toBeCloseTo(-0.05);
    expect(Number(b.total_pnl)).toBeCloseTo(0.135);
  });

  it('keeps main and sub fills apart, even with the same strike', async () => {
    const { s } = sync({ 'K-MAIN': [[fill(1, 'sell', 100, '2026-10-28T19:00:00Z')]], 'K-SUB': [[fill(2, 'buy', 50, '2026-10-28T20:00:00Z')]] }, [], [main, sub]);
    await s.runOnce();
    const list = await rows();
    expect(list.map((r) => r.account_kind)).toEqual(['main', 'sub']);
    expect(Number(list[1].total_pnl)).toBeCloseTo(-0.05);
  });

  it('reads every page', async () => {
    const { s, get } = sync({ 'K-MAIN': [[fill(1, 'sell', 100, '2026-10-28T19:00:00Z')], [fill(2, 'buy', 80, '2026-10-28T20:00:00Z')]] });
    await s.runOnce();
    expect(get).toHaveBeenCalledTimes(2);
    expect(await rows()).toHaveLength(2);
  });

  it('adds nothing twice, and resumes from the last fill', async () => {
    const pages = { 'K-MAIN': [[fill(1, 'sell', 100, '2026-10-28T19:00:00Z')]] };
    const { s, queries } = sync(pages);
    await s.runOnce();
    await s.runOnce();
    expect(await rows()).toHaveLength(1);
    expect(queries[1]).toContain(`start_time=${(Date.parse('2026-10-28T19:00:00Z') - 3_600_000) * 1000}`);
  });

  it('survives a refused read without losing stored fills', async () => {
    await sync({ 'K-MAIN': [[fill(1, 'sell', 100, '2026-10-28T19:00:00Z')]] }).s.runOnce();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { s } = sync({});
    (s as any).deps.get = async () => ({ ok: false, status: 401, body: null, errorText: 'InvalidApiKey' });
    await s.runOnce();
    expect(await rows()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('announces only new fills, not the back history', async () => {
    const seen: unknown[] = [];
    const on = (r: unknown) => seen.push(r);
    deskEvents.on('fill', on);
    await sync({ 'K-MAIN': [[fill(1, 'sell', 100, '2026-10-28T19:00:00Z'), fill(2, 'sell', 100, new Date(NOW - 60_000).toISOString())]] }).s.runOnce();
    deskEvents.off('fill', on);
    expect(seen).toHaveLength(1);
    expect((seen[0] as any).user_id).toBe(DESK_USER_ID);
  });

  it('sets a closed run from its fills, and leaves a half-seen run on its last mark', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    await pool.query(`INSERT INTO real_runs (id, user_id, account, expiry, name, status, entered_at, exited_at, net_pnl) VALUES ($1,$2,'main','271126','x','closed',$3,$4,9.99)`, [id, DESK_USER_ID, new Date(NOW - 7_200_000).toISOString(), new Date(NOW - 3_600_000).toISOString()]);
    const entry = fill(1, 'sell', 135, new Date(NOW - 7_100_000).toISOString());
    await sync({ 'K-MAIN': [[entry]] }).s.runOnce();
    const first = (await pool.query('SELECT net_pnl, pnl_source FROM real_runs WHERE id = $1', [id])).rows[0] as any;
    expect(Number(first.net_pnl)).toBe(9.99);
    await sync({ 'K-MAIN': [[entry, fill(2, 'buy', 98, new Date(NOW - 3_700_000).toISOString())]] }).s.runOnce();
    const done = (await pool.query('SELECT net_pnl, pnl_source FROM real_runs WHERE id = $1', [id])).rows[0] as any;
    expect(done.pnl_source).toBe('fills');
    expect(Number(done.net_pnl)).toBeCloseTo(0.085);
  });

  describe('reconciliation', () => {
    const open = [fill(1, 'sell', 100, '2026-10-28T19:00:00Z')];

    it('passes when positions match the fills', async () => {
      await sync({ 'K-MAIN': [open] }, [{ product_symbol: SYM, size: -5 }]).s.runOnce();
      expect(reconcileStatus(DESK_USER_ID, 'main')).toMatchObject({ state: 'ok', symbols: [] });
    });

    it('reports a mismatch only when it repeats', async () => {
      const { s } = sync({ 'K-MAIN': [open] }, [{ product_symbol: SYM, size: -7 }]);
      await s.runOnce();
      expect(reconcileStatus(DESK_USER_ID, 'main')).toBeNull();
      await s.runOnce();
      expect(reconcileStatus(DESK_USER_ID, 'main')).toMatchObject({ state: 'mismatch', symbols: [SYM] });
    });

    it('ignores expired contracts that the fills still show as open', async () => {
      const old = 'C-BTC-90000-011026';
      await sync({ 'K-MAIN': [[fill(1, 'sell', 100, '2026-09-28T19:00:00Z', { product_symbol: old })]] }, []).s.runOnce();
      expect(reconcileStatus(DESK_USER_ID, 'main')).toMatchObject({ state: 'ok' });
    });

    it('makes no claim when positions could not be read', async () => {
      await sync({ 'K-MAIN': [open] }, null).s.runOnce();
      expect(reconcileStatus(DESK_USER_ID, 'main')).toBeNull();
    });
  });
});
