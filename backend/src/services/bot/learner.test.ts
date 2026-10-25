import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

/** Auto-learn end to end on a real Postgres (PGlite): recorded days in, a promotion (or not) out. */
const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));

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

const store = await import('./bot-store.js');
const { runLearning, rollbackLast } = await import('./learner.js');
const { pool } = await import('../../db/index.js');
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params as never)).rows as any[];

const EXP = Date.parse('2026-12-30T12:00:00Z');
const SPIKE = { call: [100, 100, 210, 150, 60, 20, 20], put: [100, 90, 80, 80, 60, 40, 40] };
const FLAT = { call: [100, 100, 100, 100, 100, 100, 100], put: [100, 100, 100, 100, 100, 100, 100] };

/** One finished always-book run per day with its whole recorded day (as if shadow-tracked after an early stop). */
async function seedDays(strategy: string, n: number, spikeEvery: number) {
  for (let i = 0; i < n; i++) {
    const date = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
    const t0 = Date.parse(`${date}T04:30:00Z`);
    const path = i % spikeEvery === 0 ? SPIKE : FLAT;
    const runId = await store.insertRun({
      runKey: `${strategy}:${date}:always`, strategy, book: 'always', mode: 'paper', dateKey: date, status: 'open', entryAtMs: t0,
      plannedExitAtMs: t0 + 6 * 60_000, spotEntry: 80_000, marginUsd: 100, feesEntry: 1, tags: { gate: { dvol: 40, macroZone: 'calm', go: true } },
    });
    for (const [symbol, type] of [['C', 'call'], ['P', 'put']] as const) {
      await store.insertLeg(runId!, { symbol: `${symbol}-${date}`, type, side: 'short', role: 'body', strike: type === 'call' ? 82000 : 79000, expiryMs: EXP, lots: 100, entryPrice: 100 });
    }
    for (let k = 0; k < 7; k++) {
      await store.upsertMark({
        runId: runId!, minuteMs: t0 + k * 60_000, netPnl: 0, grossPnl: 0, pctMargin: 0, spot: 80_000,
        snapshot: { legs: [{ mark: path.call[k] }, { mark: path.put[k] }] },
      });
    }
    await store.closeRun(runId!, { exitAtMs: t0 + 6 * 60_000, grossPnl: 0, netPnl: 0, feesExit: 1 + 0.01 * (i % 5), reason: 'time', detail: 'x' });
  }
}

beforeAll(async () => {
  h.db = new PGlite() as never;
  await store.ensureBotSchema();
});
afterAll(() => undefined);
beforeEach(async () => {
  await pool.query('DELETE FROM bot_shadow_marks; DELETE FROM bot_minute_marks; DELETE FROM bot_legs; DELETE FROM bot_runs; DELETE FROM bot_params; DELETE FROM bot_learning;');
});

const NOW = Date.parse('2026-12-01T00:00:00Z');

describe('auto-learn on recorded days', () => {
  it('with too little data it only collects, and changes nothing', async () => {
    await seedDays('ASIA_SHORT', 10, 3);
    const r = await runLearning(NOW, true);
    expect(r.find((x) => x.strategy === 'ASIA_SHORT')).toMatchObject({ promoted: false, days: 10 });
    expect(r[0]!.note).toMatch(/Collecting data: 10 of 30/);
    expect(await q('SELECT 1 FROM bot_params')).toHaveLength(0);
  });

  it('promotes a clearly better stop once there are enough days, logs why, and a rollback restores the old rules', async () => {
    await seedDays('ASIA_SHORT', 45, 3);
    const [asia, ny] = await runLearning(NOW, true);
    expect(asia!.promoted).toBe(true);
    expect(asia!.champion.stopMultiple).toBeGreaterThan(2);
    expect(ny).toMatchObject({ strategy: 'NY_SHORT', promoted: false, days: 0 });
    expect((await store.getParams('ASIA_SHORT')).stopMultiple).toBe(asia!.champion.stopMultiple);
    const log = await q(`SELECT kind, reason FROM bot_learning WHERE strategy = 'ASIA_SHORT' ORDER BY id`);
    expect(log.map((l) => l.kind)).toEqual(['promotion', 'evaluation']);
    expect(log[0].reason).toMatch(/stopMultiple 2 -> .*USD\/day/);

    // a second review right away: the strategy was just changed, so it waits
    const again = await runLearning(NOW + 86_400_000, true);
    expect(again[0]!.promoted).toBe(false);

    const back = await rollbackLast('ASIA_SHORT');
    expect(back!.restored.stopMultiple).toBe(2);
    expect((await store.getParams('ASIA_SHORT')).stopMultiple).toBe(2);
    expect((await q(`SELECT kind FROM bot_learning WHERE strategy = 'ASIA_SHORT' AND kind = 'rollback'`))).toHaveLength(1);
  });

  it('with automatic promotion off it evaluates and reports but never changes the rules', async () => {
    await seedDays('ASIA_SHORT', 45, 3);
    const [asia] = await runLearning(NOW, false);
    expect(asia!.promoted).toBe(false);
    expect(asia!.note).toMatch(/automatic promotion is off/);
    expect(await q('SELECT 1 FROM bot_params')).toHaveLength(0);
  });

  it('rolling back with nothing to roll back returns null', async () => {
    expect(await rollbackLast('NY_SHORT')).toBeNull();
  });
});
