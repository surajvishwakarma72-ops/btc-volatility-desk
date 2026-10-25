import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Bar } from '../../lib/bot/futures.js';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function }, bars: [] as Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>, riskOk: true }));

vi.mock('../../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) {
        const res = await h.db.exec(text);
        const last = res[res.length - 1];
        return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 };
      }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  },
}));

vi.mock('./delta-public.js', () => ({
  DEFAULT_PERP: { symbol: 'BTCUSD', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, maxLeverage: 200, tick: 0.5 },
  fetchPerpInfo: async () => ({ symbol: 'BTCUSD', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, maxLeverage: 200, tick: 0.5 }),
  fetchCandles: async (_s: string, _r: string, startSec: number, endSec: number) => h.bars.filter((b) => b.t >= startSec * 1000 && b.t <= endSec * 1000),
  fetchBook: async () => {
    const px = h.bars.length ? h.bars[h.bars.length - 1]!.c : 80_000;
    return { bids: [[px - 0.5, 5000], [px - 1, 20000], [px - 2, 50000]], asks: [[px + 0.5, 5000], [px + 1, 20000], [px + 2, 50000]] };
  },
}));

const { FuturesLive } = await import('./futures-live.js');
const store = await import('./bot-store.js');
const { pool } = await import('../../db/index.js');

const MIN = 60_000;
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params as never)).rows as any[];

/** Winter day 2026-12-02: quiet Asia range, London sweep of its high at 08:25-08:30 UTC, then `after(m)` minutes later. */
function scenario(until: number, after: (m: number) => number): Bar[] {
  const start = Date.parse('2026-12-01T20:00:00Z');
  const sweepAt = Date.parse('2026-12-02T08:25:00Z');
  const bars: Bar[] = [];
  for (let t = start; t < until; t += MIN) {
    let o = 80_000 + Math.sin(t / 900_000) * 60;
    let hi = Math.min(o + 15, 80_100);
    let lo = Math.max(o - 15, 79_900);
    let c = o + 2;
    let v = 100;
    const m = (t - sweepAt) / MIN;
    if (m >= 0 && m < 5) {
      o = 80_090; hi = m === 2 ? 80_260 : 80_105; lo = 80_070; c = m === 4 ? 80_040 : 80_095; v = 400;
    } else if (m >= 5) {
      const p = after(m - 5);
      o = p; hi = p + 8; lo = p - 8; c = p; v = 100;
    }
    bars.push({ t, o, h: hi, l: lo, c, v });
  }
  return bars;
}

const make = () => new FuturesLive({ mode: 'paper', riskCheck: async () => (h.riskOk ? { allowed: true, reasons: [] } : { allowed: false, reasons: ['test: blocked'] }) });
const SWEEP_CLOSE = Date.parse('2026-12-02T08:30:00Z');

beforeAll(async () => {
  h.db = new PGlite() as never;
  await store.ensureBotSchema();
});
afterAll(() => undefined);
beforeEach(async () => {
  h.riskOk = true;
  await pool.query('DELETE FROM bot_minute_marks; DELETE FROM bot_events; DELETE FROM bot_fills; DELETE FROM bot_legs; DELETE FROM bot_runs;');
});

describe('futures live (paper) engine on a real Postgres', () => {
  it('enters a SHORT on the London sweep with the right levels, size and persisted state', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 6);
    const f = make();
    await f.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    const run = (await q(`SELECT * FROM bot_runs WHERE strategy = 'FUT_SWEEP_LDN'`))[0];
    expect(run.status).toBe('open');
    expect(run.run_key).toBe('FUT_SWEEP_LDN:2026-12-02:always');
    expect(run.exit_config.kind).toBe('futures');
    const st = run.exit_config.st;
    expect(st.dir).toBe('short');
    expect(st.lots).toBeLessThanOrEqual(25);
    expect(st.stop).toBeGreaterThan(80_260);
    expect(st.entry - st.target).toBeCloseTo(2 * st.riskDist, 6);
    expect(Number(run.margin_usd)).toBeGreaterThan(0);
    const leg = (await q('SELECT type, side, lots FROM bot_legs WHERE run_id = $1', [run.id]))[0];
    expect(leg).toMatchObject({ type: 'future', side: 'short' });
    expect((await q('SELECT COUNT(*)::int AS n FROM bot_fills WHERE run_id = $1', [run.id]))[0].n).toBe(1);
    expect(run.tags.signal.note).toMatch(/swept ASIA high/);
    expect(f.summary().positions).toBe(1);
  });

  it('is idempotent: another tick in the same minute (or a restart) never re-enters the session', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 6);
    const f = make();
    await f.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    await f.tick(SWEEP_CLOSE + 20_000, { allowEntries: true });
    const f2 = make();
    await f2.tick(SWEEP_CLOSE + 30_000, { allowEntries: true });
    expect((await q(`SELECT COUNT(*)::int AS n FROM bot_runs WHERE strategy = 'FUT_SWEEP_LDN'`))[0].n).toBe(1);
  });

  it('takes the target as the price falls, closing with a positive net and a maker exit fee', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 6);
    const f = make();
    await f.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    h.bars = scenario(SWEEP_CLOSE + 80 * MIN, (m) => 80_040 - m * 6);
    await f.tick(SWEEP_CLOSE + 80 * MIN + 5_000, { allowEntries: true });
    const run = (await q(`SELECT status, exit_reason, net_pnl, fees_exit, gross_pnl FROM bot_runs WHERE strategy = 'FUT_SWEEP_LDN'`))[0];
    expect(run).toMatchObject({ status: 'closed', exit_reason: 'target' });
    expect(Number(run.net_pnl)).toBeGreaterThan(0);
    expect(Number(run.gross_pnl)).toBeGreaterThan(Number(run.net_pnl));
    expect(f.summary().positions).toBe(0);
    const exitFill = (await q(`SELECT fee FROM bot_fills WHERE action = 'exit'`))[0];
    expect(Number(exitFill.fee)).toBeGreaterThan(0);
  });

  it('stops out on a rally for about the risked amount', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 + m * 6);
    const f = make();
    await f.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    h.bars = scenario(SWEEP_CLOSE + 80 * MIN, (m) => 80_040 + m * 6);
    await f.tick(SWEEP_CLOSE + 80 * MIN + 5_000, { allowEntries: true });
    const run = (await q(`SELECT exit_reason, net_pnl FROM bot_runs WHERE strategy = 'FUT_SWEEP_LDN'`))[0];
    expect(run.exit_reason).toBe('stop');
    expect(Number(run.net_pnl)).toBeLessThan(0);
    expect(Math.abs(Number(run.net_pnl))).toBeLessThan(5 + 3);
  });

  it('recovers an open position after a restart and keeps managing it (moved stops persist)', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 6);
    const f1 = make();
    await f1.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    // price falls 1.2R: breakeven moves the stop, persisted to the database
    const st0 = [...f1.open.values()][0]!.st;
    const target1R = st0.entry - st0.riskDist * 1.2;
    h.bars = scenario(SWEEP_CLOSE + 45 * MIN, (m) => Math.max(80_040 - m * 6, target1R));
    await f1.tick(SWEEP_CLOSE + 45 * MIN + 5_000, { allowEntries: true });
    const persisted = (await q(`SELECT exit_config FROM bot_runs WHERE strategy = 'FUT_SWEEP_LDN'`))[0].exit_config;
    expect(persisted.st.breakevenDone).toBe(true);
    expect(persisted.st.stop).toBeLessThanOrEqual(persisted.st.entry + 1e-9);

    const f2 = make();
    f2.restore(await q(`SELECT id, run_key, strategy, margin_usd, entry_at, exit_config FROM bot_runs WHERE status = 'open'`));
    expect(f2.open.size).toBe(1);
    expect([...f2.open.values()][0]!.st.breakevenDone).toBe(true);
    // a rally back through the entry exits at breakeven, not at the original stop
    h.bars = scenario(SWEEP_CLOSE + 70 * MIN, (m) => (m < 38 ? Math.max(80_040 - m * 6, target1R) : target1R + (m - 38) * 12));
    await f2.tick(SWEEP_CLOSE + 70 * MIN + 5_000, { allowEntries: true });
    const run = (await q(`SELECT status, exit_reason FROM bot_runs WHERE strategy = 'FUT_SWEEP_LDN'`))[0];
    expect(run.status).toBe('closed');
    expect(['breakeven', 'trail']).toContain(run.exit_reason);
  });

  it('flatten() closes every open futures position (kill switch)', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 0.2);
    const f = make();
    await f.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    expect(f.summary().positions).toBe(1);
    await f.flatten(SWEEP_CLOSE + 30_000, 'kill switch');
    expect(f.summary().positions).toBe(0);
    expect((await q(`SELECT exit_reason FROM bot_runs WHERE strategy = 'FUT_SWEEP_LDN'`))[0].exit_reason).toBe('kill switch');
  });

  it('does not enter while paused (allowEntries false) or when the risk guard blocks it', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 6);
    const paused = make();
    await paused.tick(SWEEP_CLOSE + 10_000, { allowEntries: false });
    expect(await q('SELECT 1 FROM bot_runs')).toHaveLength(0);
    h.riskOk = false;
    const blocked = make();
    await blocked.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    expect(await q('SELECT 1 FROM bot_runs')).toHaveLength(0);
    expect(await q(`SELECT 1 FROM bot_events WHERE type = 'entry_blocked'`)).not.toHaveLength(0);
  });

  it('records a minute row with R-multiple, stop and target for an open position', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 6);
    const f = make();
    await f.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    await f.record(Math.floor((SWEEP_CLOSE + 10_000) / MIN) * MIN);
    const snap = (await q('SELECT snapshot FROM bot_minute_marks'))[0].snapshot;
    expect(snap).toMatchObject({ strategy: 'FUT_SWEEP_LDN', kind: 'futures', dir: 'short' });
    expect(typeof snap.rMultiple).toBe('number');
    expect(snap.stop).toBeGreaterThan(snap.target);
  });

  it('does nothing without enough candle history', async () => {
    h.bars = scenario(SWEEP_CLOSE + 20_000, (m) => 80_040 - m * 6).slice(-100);
    const f = make();
    await f.tick(SWEEP_CLOSE + 10_000, { allowEntries: true });
    expect(await q('SELECT 1 FROM bot_runs')).toHaveLength(0);
  });
});
