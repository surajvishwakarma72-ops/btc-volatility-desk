import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function } }));
vi.mock('../../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      if (!params || params.length === 0) { const res = await h.db.exec(text); const last = res[res.length - 1]; return { rows: last?.rows ?? [], rowCount: last?.rows?.length ?? 0 }; }
      const r = await h.db.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
    },
  },
}));

const { recordSample, loadSeries, backfillDvol, ensureSeriesSchema } = await import('./series.js');

beforeAll(async () => { h.db = new PGlite() as never; await ensureSeriesSchema(); });

const NOW = Date.parse('2026-10-26T17:00:30Z');

describe('the ATM IV / DVOL series', () => {
  it('one row per minute; a later writer fills a column without wiping another', async () => {
    await recordSample({ t: NOW, atmIv: 45.5, dvol: null, spot: 100_000 });
    await recordSample({ t: NOW + 20_000, atmIv: null, dvol: 51.2, spot: null }); // same minute
    await recordSample({ t: NOW + 120_000, atmIv: 45.1, dvol: 51.0, spot: 100_050 });
    const rows = await loadSeries(NOW - 3_600_000);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ atmIv: 45.5, dvol: 51.2, spot: 100_000 });
    expect(rows[1]!.t - rows[0]!.t).toBe(120_000);
  });

  it('backfills DVOL when the table is thin, and not again once it is full', async () => {
    let calls = 0;
    const hourly = Array.from({ length: 300 }, (_, i) => [NOW - (300 - i) * 3_600_000, 50 + (i % 5)] as [number, number]);
    const fine = Array.from({ length: 288 }, (_, i) => [NOW - (288 - i) * 300_000, 52 - i * 0.01] as [number, number]);
    const fetcher = async (_s: number, _e: number, res: number) => { calls++; return res === 3600 ? hourly : fine; };
    const n = await backfillDvol(NOW, fetcher);
    expect(n).toBe(588);
    expect(calls).toBe(2);
    const rows = await loadSeries(NOW - 14 * 86_400_000);
    expect(rows.filter((r) => r.dvol != null).length).toBeGreaterThan(400);
    expect(await backfillDvol(NOW, fetcher)).toBe(0); // already enough: no call at all
    expect(calls).toBe(2);
  });
});
