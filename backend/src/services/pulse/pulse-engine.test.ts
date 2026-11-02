import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { ChainOption } from '../../lib/bot/strike-picker.js';
import type { ChainSnapshot, FeeRates, PerpQuote } from '../bot/delta-public.js';

/**
 * Engine integration test on a real Postgres (PGlite) with Delta market data mocked. Only Date is
 * faked, so the timers never fire during a test: ticks are manual. 00:00 UTC is 05:30 IST.
 */
const h = vi.hoisted(() => ({
  db: null as unknown as { query: Function; exec: Function },
  queries: 0,
  /** Any SQL containing this text throws. */
  failSql: null as string | null,
  chainDown: false,
  perpDown: false,
  listed: 3,
  noStrikes: new Set<number>(),
  /** Symbols missing from the chain. */
  gone: new Set<string>(),
  /** Expiries a fresh chain leaves out, as when parseTicker drops their tickers. */
  hidden: new Set<number>(),
  ask: new Map<string, number>(),
  mark: new Map<string, number>(),
  tradingStatus: new Map<string, string>(),
  callOi: 10,
  /** Bumped per fetch so the book moves, as a live feed does. Holds still while frozen. */
  seq: 0,
  frozen: false,
  spot: 80_000,
  chainAgeMs: 0,
  perpAgeMs: 0,
  noResponseTs: false,
  gate: null as Promise<void> | null,
}));

vi.mock('../../db/index.js', () => ({
  pool: {
    query: async (text: string, params?: unknown[]) => {
      h.queries++;
      if (h.failSql && text.includes(h.failSql)) throw new Error(`db down: ${h.failSql}`);
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

const DAY = 86_400_000;
const EXPIRIES = Array.from({ length: 12 }, (_, i) => Date.parse('2026-10-30T12:00:00Z') + i * DAY);
const FEE: FeeRates = { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 };
const CALL_FEE: FeeRates = { ...FEE, takerRate: 0.0003 };

function mockChain(nowMs: number): ChainSnapshot {
  const expiries = EXPIRIES.filter((e) => e > nowMs).slice(0, h.listed).filter((e) => !h.hidden.has(e));
  const options: ChainOption[] = [];
  const responseTsMs = h.noResponseTs ? undefined : nowMs - h.chainAgeMs;
  if (!h.frozen) h.seq++;
  if (expiries[0] !== undefined) options.push({ symbol: 'C-TICKER', type: 'call', strike: 99000, expiryMs: expiries[0], delta: 0.5, bid: 1 + h.seq, ask: 2 + h.seq, mark: 1, iv: 40, responseTsMs });
  for (const e of expiries) {
    const delta = h.noStrikes.has(e) ? 0.3 : 0.125;
    const callSym = `C-88000-${e}`;
    const putSym = `P-72000-${e}`;
    if (!h.gone.has(callSym)) {
      options.push({ symbol: callSym, type: 'call', strike: 88000, expiryMs: e, delta, bid: 100, ask: h.ask.get(callSym) ?? 110, mark: h.mark.get(callSym) ?? 105, iv: 40, theta: -5, gamma: 0.001, vega: 3, responseTsMs, oi: h.callOi, volume: 5, tradingStatus: h.tradingStatus.get(callSym) });
    }
    if (!h.gone.has(putSym)) {
      options.push({ symbol: putSym, type: 'put', strike: 72000, expiryMs: e, delta, bid: 90, ask: h.ask.get(putSym) ?? 100, mark: h.mark.get(putSym) ?? 95, iv: 41, theta: -4, gamma: 0.002, vega: 4, responseTsMs, oi: 20, volume: 8 });
    }
  }
  return { fetchedAt: nowMs, spot: h.spot, options, greeks: new Map(), expiries };
}

const mocks = vi.hoisted(() => ({
  fetchChain: vi.fn(),
  fetchPerpQuote: vi.fn(),
  fetchOptionFeeRates: vi.fn(),
}));

vi.mock('../bot/delta-public.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bot/delta-public.js')>()),
  fetchChain: mocks.fetchChain,
  fetchPerpQuote: mocks.fetchPerpQuote,
  fetchOptionFeeRates: mocks.fetchOptionFeeRates,
}));

const store = await import('./pulse-store.js');
const { pool } = await import('../../db/index.js');
const { PulseEngine } = await import('./pulse-engine.js');
const { pulseRoutes } = await import('../../routes/pulse.js');
const { legNetPnl } = await import('../../lib/pulse/cohort.js');

type Engine = InstanceType<typeof PulseEngine>;

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params as never)).rows as any[];
const count = async (sql: string, params: unknown[] = []) => Number((await q(`SELECT count(*)::int AS n ${sql}`, params))[0].n);
const events = (type: string) => q('SELECT type, slot, detail FROM pulse_events WHERE type = $1 ORDER BY id', [type]);
const T = (iso: string) => Date.parse(iso);

async function at(e: Engine, iso: string) {
  const ms = T(iso);
  vi.setSystemTime(ms);
  await e.tick(ms);
}

const engines: Engine[] = [];
function engine(): Engine {
  const e = new PulseEngine();
  engines.push(e);
  return e;
}

beforeAll(async () => {
  h.db = new PGlite() as never;
  vi.useFakeTimers({ toFake: ['Date'] });
  await store.ensurePulseSchema();
});
afterAll(async () => {
  vi.useRealTimers();
  await (h.db as unknown as PGlite).close();
});
beforeEach(async () => {
  process.env.PULSE_ENABLED = 'true';
  Object.assign(h, { callOi: 10, frozen: false, queries: 0, failSql: null, chainDown: false, perpDown: false, listed: 3, spot: 80_000, chainAgeMs: 0, perpAgeMs: 0, noResponseTs: false, gate: null });
  h.noStrikes.clear();
  h.gone.clear();
  h.hidden.clear();
  h.ask.clear();
  h.mark.clear();
  h.tradingStatus.clear();
  mocks.fetchChain.mockReset().mockImplementation(async (nowMs: number) => {
    if (h.gate) await h.gate;
    if (h.chainDown) throw new Error('chain down');
    return mockChain(nowMs);
  });
  mocks.fetchPerpQuote.mockReset().mockImplementation(async (): Promise<PerpQuote> => {
    if (h.perpDown) throw new Error('perp down');
    return { bid: 79_990, ask: 80_010, mark: 80_000, spot: h.spot, tsMs: Date.now() - h.perpAgeMs };
  });
  mocks.fetchOptionFeeRates.mockReset().mockImplementation(
    async (symbols: string[]) => new Map(symbols.map((s) => [s, s.startsWith('C-') ? CALL_FEE : FEE])),
  );
  await pool.query('DELETE FROM pulse_leg_snapshots; DELETE FROM pulse_cohort_snapshots; DELETE FROM pulse_events; DELETE FROM pulse_cohorts; DELETE FROM pulse_market_snapshots; DELETE FROM pulse_minute;');
  h.queries = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  for (const e of engines.splice(0)) e.stop();
  vi.restoreAllMocks();
  delete process.env.PULSE_ENABLED;
});

const E_NOV1 = T('2026-11-01T12:00:00Z');
const E_NOV2 = T('2026-11-02T12:00:00Z');
const E_NOV3 = T('2026-11-03T12:00:00Z');
const E_NOV4 = T('2026-11-04T12:00:00Z');

describe('PulseEngine lifecycle', () => {
  it('does nothing unless PULSE_ENABLED=true', async () => {
    delete process.env.PULSE_ENABLED;
    const e = engine();
    expect(e.enabled).toBe(false);
    await e.start();
    await at(e, '2026-11-01T00:00:00Z');
    expect(h.queries).toBe(0);
    expect(mocks.fetchChain).not.toHaveBeenCalled();
    expect(mocks.fetchPerpQuote).not.toHaveBeenCalled();
    expect(e.status()).toMatchObject({ enabled: false, lastTickAt: null, lastError: null, dataOk: false, dbSizeBytes: null });
    process.env.PULSE_ENABLED = 'false';
    expect(e.enabled).toBe(false);
  });

  it('aligns the timer to the next minute and ticks at once on start', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    vi.setSystemTime(T('2026-11-01T00:00:20Z'));
    const e = engine();
    await e.start();
    expect(spy.mock.calls.some((c) => c[1] === 40_000)).toBe(true);
    expect(await count('FROM pulse_cohorts')).toBe(3);
  });

  it('a failed startup does not throw, reports, and retries until stopped', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    h.failSql = 'max(grid_ms)';
    const e = engine();
    await e.start();
    expect(e.status().lastError).toContain('startup failed');
    expect(spy.mock.calls.some((c) => c[1] === 5_000)).toBe(true);
    expect(mocks.fetchChain).not.toHaveBeenCalled();
    h.failSql = null;
    await e.start();
    expect(e.status().lastError).toBeNull();
    expect(mocks.fetchChain).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous one is still running', async () => {
    const e = engine();
    let release = () => {};
    h.gate = new Promise<void>((r) => { release = r; });
    vi.setSystemTime(T('2026-11-01T00:00:00Z'));
    const first = e.tick();
    await e.tick();
    expect(mocks.fetchChain).toHaveBeenCalledTimes(1);
    h.gate = null;
    release();
    await first;
    expect(await count('FROM pulse_cohorts')).toBe(3);
  });

  it('reports status in the agreed shape', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    const s = e.status();
    expect(s).toMatchObject({ enabled: true, lastTickAt: T('2026-11-01T00:00:00Z'), lastGoodTickAt: T('2026-11-01T00:00:00Z'), lastError: null, dataOk: true });
    expect(s.dbSizeBytes).toBeGreaterThan(0);
    expect(Object.keys(s.slots)).toEqual(['current', 'next', 'n2n']);
    const rows = await q(`SELECT slot, series_id FROM pulse_cohorts`);
    for (const r of rows) expect(s.slots[r.slot as 'current'].seriesId).toBe(r.series_id);
    expect(s.slots.current).toMatchObject({ expiryMs: E_NOV1, live: 1 });
    expect(s.slots.next).toMatchObject({ expiryMs: E_NOV2, live: 1 });
    expect(s.slots.n2n).toMatchObject({ expiryMs: E_NOV3, live: 1 });
  });

  it('GET /pulse/status needs auth and returns the status', async () => {
    const app = fastify({ logger: false });
    app.decorate('authenticate', async (req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
      if (!req.headers.authorization) return reply.code(401).send({ success: false });
    });
    await app.register(pulseRoutes, { prefix: '/api/v1/pulse' });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/v1/pulse/status' })).statusCode).toBe(401);
    const res = await app.inject({ method: 'GET', url: '/api/v1/pulse/status', headers: { authorization: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['dataOk', 'dbSizeBytes', 'enabled', 'lastError', 'lastGoodTickAt', 'lastTickAt', 'slots', 'success'].sort());
    await app.close();
  });

  it('never imports an order module', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dirs = [here, join(here, '..', '..', 'lib', 'pulse'), join(here, '..', '..', 'lib', 'pulse', 'metrics'), join(here, '..', '..', 'lib', 'pulse', 'regime')];
    const files = dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(d, f)));
    files.push(join(here, '..', '..', 'routes', 'pulse.ts'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    const names = files.map((f) => f.replace(/\\/g, '/'));
    for (const want of ['lib/pulse/regime/gate.ts', 'lib/pulse/regime/indicators.ts', 'services/pulse/regime-service.ts', 'services/pulse/hourly-bars.ts', 'routes/pulse.ts']) {
      expect(names.some((n) => n.endsWith(want)), `scan covers ${want}`).toBe(true);
    }
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const banned of ['paper-broker', 'live-entry', 'brokers', 'stop-order', 'delta-keys', 'bot-engine']) {
        expect(src, `${f} mentions ${banned}`).not.toContain(banned);
      }
    }
  });
});

describe('opening', () => {
  it('opens one cohort per slot at 05:30 IST and stores entry at bid', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    const rows = await store.liveCohorts();
    expect(rows.map((c) => [c.slot, c.expiry_ms]).sort()).toEqual([['current', E_NOV1], ['n2n', E_NOV3], ['next', E_NOV2]]);
    const c = rows.find((r) => r.slot === 'current')!;
    expect(c).toMatchObject({
      status: 'open', slot_ms: T('2026-11-01T00:00:00Z'), opened_at: T('2026-11-01T00:00:00Z'), spot_entry: 80_000, fut_entry_bid: 79_990, fut_entry_ask: 80_010,
      call_symbol: `C-88000-${E_NOV1}`, put_symbol: `P-72000-${E_NOV1}`, call_strike: 88000, put_strike: 72000, call_bid: 100, put_bid: 90, call_mid: 105, put_mid: 95,
      call_delta: 0.125, put_delta: 0.125, call_theta: -5, put_theta: -4, call_iv: 40, put_iv: 41, net_pnl: null,
      call_gamma: 0.001, put_gamma: 0.002, call_vega: 3, put_vega: 4, call_oi_band: 10, put_oi_band: 20,
    });
    expect(c.fee).toEqual(CALL_FEE);
    expect(mocks.fetchOptionFeeRates).toHaveBeenCalledTimes(1);
    expect(mocks.fetchOptionFeeRates.mock.calls[0]![0]).toHaveLength(6);
    await at(e, '2026-11-01T00:01:00Z');
    expect(mocks.fetchOptionFeeRates).toHaveBeenCalledTimes(1);
    expect(await count('FROM pulse_cohorts')).toBe(3);
  });

  it('opens 24 per slot across a simulated day of minute ticks, up to the roll', async () => {
    const e = engine();
    const start = T('2026-10-31T12:00:00Z');
    for (let i = 0; i < 1440; i++) {
      vi.setSystemTime(start + i * 60_000);
      await e.tick(start + i * 60_000);
    }
    expect(e.status().lastError).toBeNull();
    const rows = await q(`SELECT slot, expiry_ms, count(*)::int AS n, count(DISTINCT series_id)::int AS series FROM pulse_cohorts WHERE status = 'open' GROUP BY slot, expiry_ms ORDER BY slot`);
    expect(rows.map((r) => [r.slot, Number(r.expiry_ms), r.n, r.series])).toEqual([
      ['current', E_NOV1, 24, 1],
      ['n2n', E_NOV3, 24, 1],
      ['next', E_NOV2, 24, 1],
    ]);
    expect(mocks.fetchOptionFeeRates).toHaveBeenCalledTimes(24);
  }, 240_000);

  it('stores NO_VALID_STRIKES as a futures-only cohort and an event, then keeps the futures pair running', async () => {
    h.noStrikes.add(E_NOV3);
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    const row = (await q(`SELECT status, missing, net_pnl, call_symbol, fee, fut_entry_bid, fut_entry_ask FROM pulse_cohorts WHERE slot = 'n2n'`))[0];
    expect(row).toMatchObject({ status: 'futures_only', missing: ['call', 'put'], net_pnl: null, call_symbol: null });
    expect(row.fut_entry_bid).not.toBeNull();
    expect(row.fut_entry_ask).not.toBeNull();
    expect(row.fee).toBeTruthy();
    expect(await events('NO_VALID_STRIKES')).toMatchObject([{ slot: 'n2n', detail: { missing: ['call', 'put'] } }]);
    expect((await store.liveCohorts()).map((c) => c.slot).sort()).toEqual(['current', 'n2n', 'next']);
    expect(e.status().slots.n2n.live).toBe(1);
    expect(mocks.fetchOptionFeeRates.mock.calls[0]![0]).toHaveLength(4);

    await at(e, '2026-11-01T00:15:00Z');
    expect(await events('NO_VALID_STRIKES')).toHaveLength(1);
    expect(await count('FROM pulse_cohorts')).toBe(3);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(3);
    const fut = (await q(`SELECT s.data_ok, s.fut_long_pnl, s.fut_short_pnl FROM pulse_cohort_snapshots s JOIN pulse_cohorts c ON c.id = s.cohort_id WHERE c.slot = 'n2n'`))[0];
    expect(fut.data_ok).toBe(true);
    expect(fut.fut_long_pnl).not.toBeNull();
    expect(fut.fut_short_pnl).not.toBeNull();
  });

  it('does not call the fee endpoint when every slot has no valid strikes', async () => {
    for (const x of [E_NOV1, E_NOV2, E_NOV3]) h.noStrikes.add(x);
    await at(engine(), '2026-11-01T00:00:00Z');
    expect(mocks.fetchOptionFeeRates).not.toHaveBeenCalled();
    expect(await events('NO_VALID_STRIKES')).toHaveLength(3);
  });

  it('API down at HH:30, back 3 minutes later: opens late', async () => {
    const e = engine();
    h.chainDown = true;
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-01T00:01:00Z');
    expect(e.status().dataOk).toBe(false);
    expect(await count('FROM pulse_cohorts')).toBe(0);
    h.chainDown = false;
    await at(e, '2026-11-01T00:03:00Z');
    expect(e.status().dataOk).toBe(true);
    const rows = await store.liveCohorts();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ slot_ms: T('2026-11-01T00:00:00Z'), opened_at: T('2026-11-01T00:03:00Z') });
    expect(await events('DATA_STALE')).toHaveLength(1);
    expect(await events('MISSED_OPEN')).toHaveLength(0);
  });

  it('opens at exactly the end of the grace period', async () => {
    await at(engine(), '2026-11-01T00:05:00Z');
    expect(await count('FROM pulse_cohorts')).toBe(3);
    expect(await events('MISSED_OPEN')).toHaveLength(0);
  });

  it('API down past 5 minutes: logs MISSED_OPEN, opens nothing for that hour', async () => {
    const e = engine();
    h.chainDown = true;
    await at(e, '2026-11-01T00:00:00Z');
    h.chainDown = false;
    await at(e, '2026-11-01T00:05:01Z');
    await at(e, '2026-11-01T00:06:00Z');
    await at(e, '2026-11-01T00:59:00Z');
    expect(await count('FROM pulse_cohorts')).toBe(0);
    const missed = await events('MISSED_OPEN');
    expect(missed.map((m) => m.slot).sort()).toEqual(['current', 'n2n', 'next']);
    expect(missed[0].detail).toMatchObject({ slotMs: T('2026-11-01T00:00:00Z') });
    await at(e, '2026-11-01T01:00:00Z');
    expect(await count('FROM pulse_cohorts')).toBe(3);
    expect(await events('MISSED_OPEN')).toHaveLength(3);
  });
});

describe('snapshots', () => {
  it('takes 2 leg rows and 1 cohort row per live cohort each 15 minutes', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    expect(await count('FROM pulse_leg_snapshots')).toBe(0); // opened on a grid tick: first snapshot is the next grid
    await at(e, '2026-11-01T00:14:00Z');
    expect(await count('FROM pulse_leg_snapshots')).toBe(0);
    await at(e, '2026-11-01T00:15:00Z');
    await at(e, '2026-11-01T00:16:00Z');
    expect(await count('FROM pulse_leg_snapshots')).toBe(6);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(3);
    await at(e, '2026-11-01T00:30:00Z');
    expect(await count('FROM pulse_leg_snapshots')).toBe(12);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(6);
    const leg = (await q(`SELECT l.* FROM pulse_leg_snapshots l JOIN pulse_cohorts c ON c.id = l.cohort_id WHERE c.slot = 'current' AND l.leg = 'call' AND l.grid_ms = $1`, [T('2026-11-01T00:15:00Z')]))[0];
    expect(Number(leg.minutes_since_entry)).toBe(15);
    expect(Number(leg.ask)).toBe(110);
    expect(leg.data_ok).toBe(true);
  });

  it('records the sample time and minutes from it on a late first-healthy tick', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.chainDown = true;
    await at(e, '2026-11-01T00:15:00Z');
    h.chainDown = false;
    await at(e, '2026-11-01T00:22:00Z');
    const grid = T('2026-11-01T00:15:00Z');
    const leg = (await q('SELECT sampled_ms, minutes_since_entry FROM pulse_leg_snapshots WHERE grid_ms = $1 LIMIT 1', [grid]))[0];
    expect(Number(leg.sampled_ms)).toBe(T('2026-11-01T00:22:00Z'));
    expect(Number(leg.minutes_since_entry)).toBe(22);
    const row = (await q('SELECT sampled_ms FROM pulse_cohort_snapshots WHERE grid_ms = $1 LIMIT 1', [grid]))[0];
    expect(Number(row.sampled_ms)).toBe(T('2026-11-01T00:22:00Z'));
  });

  it('the first snapshot measures oi_change from the entry band', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.callOi = 16;
    await at(e, '2026-11-01T00:15:00Z');
    await at(e, '2026-11-01T00:30:00Z');
    const rows = await q(`SELECT oi_change FROM pulse_leg_snapshots l JOIN pulse_cohorts c ON c.id = l.cohort_id WHERE c.slot = 'current' AND l.leg = 'call' ORDER BY grid_ms`);
    expect(rows.map((r) => Number(r.oi_change))).toEqual([6, 0]);
  });

  it('a non-operational sold leg is stored data_ok=false and cannot latch a stop', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    const symbol = `C-88000-${E_NOV1}`;
    h.tradingStatus.set(symbol, 'disrupted_post_only');
    h.ask.set(symbol, 200);
    h.mark.set(symbol, 190);
    await at(e, '2026-11-01T00:15:00Z');
    const c = (await store.liveCohorts()).find((r) => r.slot === 'current')!;
    expect(c.call_sl_at).toBeNull();
    expect(await q(`SELECT data_ok, sl_hit FROM pulse_leg_snapshots WHERE cohort_id = $1 AND leg = 'call'`, [c.id])).toMatchObject([{ data_ok: false, sl_hit: false }]);
  });

  it('a skipped grid logs SNAPSHOT_GAP and snapshots only the current grid', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-01T00:15:00Z');
    h.chainDown = true;
    await at(e, '2026-11-01T00:30:00Z');
    h.chainDown = false;
    await at(e, '2026-11-01T00:47:00Z');
    const gaps = await events('SNAPSHOT_GAP');
    expect(gaps).toHaveLength(1);
    expect(gaps[0].detail).toEqual({ from: T('2026-11-01T00:15:00Z'), to: T('2026-11-01T00:45:00Z') });
    const grids = (await q('SELECT DISTINCT grid_ms FROM pulse_cohort_snapshots ORDER BY grid_ms')).map((r) => Number(r.grid_ms));
    expect(grids).toEqual([T('2026-11-01T00:15:00Z'), T('2026-11-01T00:45:00Z')]);
  });

  it('consecutive grids log no gap', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-01T00:15:00Z');
    await at(e, '2026-11-01T00:30:00Z');
    expect(await events('SNAPSHOT_GAP')).toHaveLength(0);
  });
});

describe('stale data', () => {
  const cases: Array<[string, () => void]> = [
    ['chain fetch fails', () => { h.chainDown = true; }],
    ['perp fetch fails', () => { h.perpDown = true; }],
    ['perp quote too old', () => { h.perpAgeMs = 120_001; }],
    ['newest chain quote too old', () => { h.chainAgeMs = 120_001; }],
    ['no option has a quote time', () => { h.noResponseTs = true; }],
  ];
  it.each(cases)('%s: does nothing else that tick', async (_name, breakIt) => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-01T00:15:00Z');
    const before = await count('FROM pulse_cohort_snapshots');
    breakIt();
    // The grid, a roll and an open are all due here; none may happen.
    await at(e, '2026-11-01T12:00:00Z');
    expect(e.status().dataOk).toBe(false);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(before);
    expect(await count('FROM pulse_cohorts')).toBe(3);
    expect(await count(`FROM pulse_cohorts WHERE status = 'open'`)).toBe(3);
    expect(await events('DATA_STALE')).toHaveLength(1);
  });

  it('a quote exactly at the limit is not stale', async () => {
    h.chainAgeMs = 120_000;
    h.perpAgeMs = 120_000;
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    expect(e.status().dataOk).toBe(true);
    expect(await count('FROM pulse_cohorts')).toBe(3);
  });

  it('DATA_STALE logs once per outage and again for a new outage', async () => {
    const e = engine();
    h.chainDown = true;
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-01T00:01:00Z');
    h.chainDown = false;
    await at(e, '2026-11-01T00:02:00Z');
    h.perpDown = true;
    await at(e, '2026-11-01T00:03:00Z');
    expect(await events('DATA_STALE')).toHaveLength(2);
  });
});

describe('rolls', () => {
  it('a roll closes only what expired: older strangles keep recording beside the new series', async () => {
    const e = engine();
    await at(e, '2026-11-01T10:00:00Z');
    await at(e, '2026-11-01T11:00:00Z');
    const before = await store.liveCohorts();
    expect(before).toHaveLength(6);
    const oldSeries = Object.fromEntries(before.map((c) => [c.slot, c.series_id]));

    h.spot = 88_500;
    await at(e, '2026-11-01T12:00:00Z');

    const closed = await q(`SELECT slot, close_reason, closed_at, net_pnl FROM pulse_cohorts WHERE status = 'closed' ORDER BY slot`);
    expect(closed).toHaveLength(2);
    expect(closed.every((c) => c.slot === 'current' && c.close_reason === 'EXPIRED')).toBe(true);
    expect(new Date(closed[0].closed_at).getTime()).toBe(T('2026-11-01T12:00:00Z'));
    const expected = legNetPnl({ entryBid: 100, ask: 500, spot: 88_500, fee: CALL_FEE }) + legNetPnl({ entryBid: 90, ask: 0, spot: 88_500, fee: CALL_FEE });
    expect(Number(closed[0].net_pnl)).toBeCloseTo(expected, 8);

    const live = await store.liveCohorts();
    expect(live).toHaveLength(7);
    const fresh = live.filter((c) => c.slot_ms === T('2026-11-01T12:00:00Z'));
    expect(fresh.map((c) => [c.slot, c.expiry_ms]).sort()).toEqual([['current', E_NOV2], ['n2n', E_NOV4], ['next', E_NOV3]]);
    for (const c of fresh) {
      expect(c.series_id).not.toBe(oldSeries[c.slot]);
      expect(e.status().slots[c.slot].seriesId).toBe(c.series_id);
    }
    // The four older strangles are still sampled on the 12:00 grid; the new cohorts wait for the next one.
    expect(await count('FROM pulse_cohort_snapshots WHERE grid_ms = $1', [T('2026-11-01T12:00:00Z')])).toBe(4);
  });

  it('an older strangle closes at its own expiry, even after an outage across the roll', async () => {
    const e = engine();
    await at(e, '2026-11-01T11:00:00Z');
    h.chainDown = true;
    await at(e, '2026-11-01T12:01:00Z');
    h.chainDown = false;
    await at(e, '2026-11-01T12:03:00Z');
    const closed = await q(`SELECT slot, close_reason FROM pulse_cohorts WHERE status = 'closed'`);
    expect(closed).toEqual([{ slot: 'current', close_reason: 'EXPIRED' }]);
    expect((await store.liveCohorts()).filter((c) => c.slot_ms === T('2026-11-01T11:00:00Z')).map((c) => c.slot).sort()).toEqual(['n2n', 'next']);
  });

  it('two expiries listed: logs SLOT_MISSING for n2n, others run', async () => {
    h.listed = 2;
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-01T00:01:00Z');
    expect(await events('SLOT_MISSING')).toMatchObject([{ slot: 'n2n' }]);
    expect((await store.liveCohorts()).map((c) => c.slot).sort()).toEqual(['current', 'next']);
    expect(e.status().slots.n2n).toMatchObject({ expiryMs: null, live: 0 });
    h.listed = 3;
    await at(e, '2026-11-01T00:06:00Z'); // past the grace, so n2n stays empty
    expect(await count(`FROM pulse_cohorts WHERE slot = 'n2n'`)).toBe(0);
    h.listed = 2;
    await at(e, '2026-11-01T00:07:00Z');
    expect(await events('SLOT_MISSING')).toHaveLength(2);
  });

  it('a slot that comes back inside the grace opens', async () => {
    h.listed = 2;
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.listed = 3;
    await at(e, '2026-11-01T00:02:00Z');
    expect(await count(`FROM pulse_cohorts WHERE slot = 'n2n'`)).toBe(1);
  });

  it('a live cohort whose slot is missing stays open until its expiry, then closes EXPIRED', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.listed = 2; // the 12:00 roll leaves Nov 2 and Nov 3: n2n has no slot, its expiry is still listed
    await at(e, '2026-11-01T12:00:00Z');
    expect(await count(`FROM pulse_cohorts WHERE slot = 'n2n' AND status = 'open'`)).toBe(1);
    expect(e.status().slots.n2n).toMatchObject({ expiryMs: null, live: 1 });
    await at(e, '2026-11-01T12:15:00Z');
    const n2n = (await store.liveCohorts()).find((c) => c.slot === 'n2n')!;
    expect(await count('FROM pulse_cohort_snapshots WHERE cohort_id = $1', [n2n.id])).toBe(2); // still snapshotted, at 12:00 and 12:15
    h.listed = 0;
    await at(e, '2026-11-03T12:00:00Z');
    expect(e.status().dataOk).toBe(false); // no options at all reads as stale
    h.listed = 1;
    await at(e, '2026-11-03T12:01:00Z');
    expect(await q(`SELECT status, close_reason FROM pulse_cohorts WHERE slot = 'n2n' AND slot_ms = $1`, [T('2026-11-01T00:00:00Z')])).toMatchObject([{ status: 'closed', close_reason: 'EXPIRED' }]);
  });

  it('a slot with only no_valid_strikes rows still gets a new series on the roll', async () => {
    h.noStrikes.add(E_NOV2);
    const e = engine();
    await at(e, '2026-11-01T11:00:00Z');
    const old = (await q(`SELECT series_id FROM pulse_cohorts WHERE slot = 'next'`))[0].series_id;
    h.noStrikes.clear();
    await at(e, '2026-11-01T12:00:00Z');
    const live = (await store.liveCohorts()).find((c) => c.slot === 'next' && c.slot_ms === T('2026-11-01T12:00:00Z'))!;
    expect(live.expiry_ms).toBe(E_NOV3);
    expect(live.series_id).not.toBe(old);
  });
});

describe('restarts', () => {
  it('restart mid-hour: a new engine creates no duplicate cohort or snapshot', async () => {
    const a = engine();
    await at(a, '2026-11-01T00:00:00Z');
    await at(a, '2026-11-01T00:15:00Z');
    const series = (await store.liveCohorts()).map((c) => c.series_id).sort();
    a.stop();

    vi.setSystemTime(T('2026-11-01T00:17:00Z'));
    const b = engine();
    await b.start();
    await at(b, '2026-11-01T00:18:00Z');
    expect(await count('FROM pulse_cohorts')).toBe(3);
    expect(await count('FROM pulse_leg_snapshots')).toBe(6);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(3);
    expect(await events('SNAPSHOT_GAP')).toHaveLength(0);
    expect(b.status().slots.current.live).toBe(1);

    await at(b, '2026-11-01T01:00:00Z');
    const after = await store.liveCohorts();
    expect(after).toHaveLength(6);
    expect([...new Set(after.map((c) => c.series_id))].sort()).toEqual(series);
  });

  it('status shows restored series and live counts straight after start, before any healthy tick', async () => {
    const a = engine();
    await at(a, '2026-11-01T00:00:00Z');
    const live = await store.liveCohorts();
    a.stop();
    h.chainDown = true;
    vi.setSystemTime(T('2026-11-01T00:02:00Z'));
    const b = engine();
    await b.start();
    const s = b.status();
    expect(s.slots.next.live).toBe(1);
    expect(s.slots.next.seriesId).toBe(live.find((c) => c.slot === 'next')!.series_id);
  });

  it('restart across a skipped grid logs SNAPSHOT_GAP from the stored grid', async () => {
    const a = engine();
    await at(a, '2026-11-01T00:00:00Z');
    await at(a, '2026-11-01T00:15:00Z');
    a.stop();
    vi.setSystemTime(T('2026-11-01T01:01:00Z'));
    const b = engine();
    await b.start();
    expect((await events('SNAPSHOT_GAP'))[0].detail).toEqual({ from: T('2026-11-01T00:15:00Z'), to: T('2026-11-01T01:00:00Z') });
  });

  it('restart across a roll keeps unexpired cohorts and starts a new series', async () => {
    const a = engine();
    await at(a, '2026-11-01T11:00:00Z');
    const old = await store.liveCohorts();
    a.stop();
    vi.setSystemTime(T('2026-11-01T12:02:00Z'));
    const b = engine();
    await b.start();
    const live = (await store.liveCohorts()).filter((c) => c.slot_ms === T('2026-11-01T12:00:00Z'));
    expect(live.map((c) => c.expiry_ms).sort()).toEqual([E_NOV2, E_NOV3, E_NOV4]);
    expect(live.some((c) => old.some((o) => o.series_id === c.series_id))).toBe(false);
  });

  it('a crash after closing but before opening does not reuse the old series', async () => {
    const a = engine();
    await at(a, '2026-11-01T11:00:00Z');
    const old = await store.liveCohorts();
    h.failSql = 'INSERT INTO pulse_cohorts';
    await at(a, '2026-11-01T12:00:00Z');
    expect(await count(`FROM pulse_cohorts WHERE status = 'open'`)).toBe(2);
    a.stop();
    h.failSql = null;
    vi.setSystemTime(T('2026-11-01T12:01:00Z'));
    const b = engine();
    await b.start();
    const live = (await store.liveCohorts()).filter((c) => c.slot_ms === T('2026-11-01T12:00:00Z'));
    expect(live).toHaveLength(3);
    expect(live.some((c) => old.some((o) => o.series_id === c.series_id))).toBe(false);
  });
});

describe('minute stops', () => {
  const symbol = `C-88000-${E_NOV1}`;
  const current = async () => (await q(`SELECT call_sl_at, put_sl_at FROM pulse_cohorts WHERE slot = 'current' ORDER BY slot_ms LIMIT 1`))[0];
  const touch = () => { h.ask.set(symbol, 200); h.mark.set(symbol, 190); };

  it('a touch that recovers between grids sets the stop and the next snapshot shows it', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    touch();
    await at(e, '2026-11-01T00:07:00Z');
    h.ask.clear();
    h.mark.clear();
    await at(e, '2026-11-01T00:08:00Z');
    expect(new Date((await current()).call_sl_at).getTime()).toBe(T('2026-11-01T00:07:00Z'));
    expect((await current()).put_sl_at).toBeNull();
    await at(e, '2026-11-01T00:15:00Z');
    const sl = await q(`SELECT l.sl_hit FROM pulse_leg_snapshots l JOIN pulse_cohorts c ON c.id = l.cohort_id WHERE c.slot = 'current' AND l.leg = 'call'`);
    expect(sl).toMatchObject([{ sl_hit: true }]);
  });

  it('a touch at 11:59 UTC is recorded before the 12:00 roll', async () => {
    const e = engine();
    await at(e, '2026-11-01T11:00:00Z');
    touch();
    await at(e, '2026-11-01T11:59:00Z');
    await at(e, '2026-11-01T12:00:00Z');
    const row = (await q(`SELECT status, call_sl_at FROM pulse_cohorts WHERE slot = 'current' AND slot_ms = $1`, [T('2026-11-01T11:00:00Z')]))[0];
    expect(row.status).toBe('closed');
    expect(new Date(row.call_sl_at).getTime()).toBe(T('2026-11-01T11:59:00Z'));
  });

  it('a spiked ask with a normal mark does not latch', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.ask.set(symbol, 200); // mark stays 105
    await at(e, '2026-11-01T00:01:00Z');
    await at(e, '2026-11-01T00:15:00Z');
    expect((await current()).call_sl_at).toBeNull();
    expect(await count('FROM pulse_leg_snapshots WHERE sl_hit')).toBe(0);
  });

  it('no stop is tested on an unhealthy tick', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    touch();
    h.perpDown = true;
    await at(e, '2026-11-01T00:01:00Z');
    expect((await current()).call_sl_at).toBeNull();
  });
});

describe('frozen feed', () => {
  const minute = (m: number) => `2026-11-01T00:${String(m).padStart(2, '0')}:00Z`;

  it('five unchanged ticks are unhealthy: FEED_FROZEN once, nothing written, then recovers', async () => {
    const e = engine();
    await at(e, minute(0));
    h.frozen = true;
    for (let m = 1; m <= 4; m++) await at(e, minute(m));
    expect(e.status().dataOk).toBe(true);
    await at(e, minute(5));
    expect(e.status().dataOk).toBe(false);
    await at(e, minute(15)); // a grid
    await at(e, minute(16));
    expect(await events('FEED_FROZEN')).toHaveLength(1);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(0);

    h.frozen = false;
    await at(e, minute(17));
    expect(e.status().dataOk).toBe(true);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(3);
  });

  it('a change resets the count', async () => {
    const e = engine();
    await at(e, minute(0));
    h.frozen = true;
    for (let m = 1; m <= 4; m++) await at(e, minute(m));
    h.frozen = false;
    await at(e, minute(5));
    h.frozen = true;
    for (let m = 6; m <= 9; m++) await at(e, minute(m));
    expect(e.status().dataOk).toBe(true);
    expect(await events('FEED_FROZEN')).toHaveLength(0);
  });
});

describe('MISSED_OPEN walk', () => {
  it('a multi-hour outage logs every missed hour once per slot, and a restart does not repeat them', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.chainDown = true;
    await at(e, '2026-11-01T01:00:00Z');
    h.chainDown = false;
    await at(e, '2026-11-01T03:02:00Z'); // 03:00 is inside the grace and opens late
    await at(e, '2026-11-01T03:03:00Z');
    const missed = await events('MISSED_OPEN');
    expect(missed.filter((m) => m.slot === 'current').map((m) => m.detail)).toEqual([
      { slotMs: T('2026-11-01T01:00:00Z') },
      { slotMs: T('2026-11-01T02:00:00Z') },
    ]);
    expect(missed).toHaveLength(6);
    expect(await count('FROM pulse_cohorts WHERE slot_ms = $1', [T('2026-11-01T03:00:00Z')])).toBe(3);

    e.stop();
    vi.setSystemTime(T('2026-11-01T03:04:00Z'));
    await engine().start();
    expect(await events('MISSED_OPEN')).toHaveLength(6);
  });

  it('an hour past the grace is logged once across a restart', async () => {
    const a = engine();
    await at(a, '2026-11-01T00:06:00Z');
    expect(await events('MISSED_OPEN')).toHaveLength(3);
    a.stop();
    vi.setSystemTime(T('2026-11-01T00:07:00Z'));
    await engine().start();
    expect(await events('MISSED_OPEN')).toHaveLength(3);
  });

  it('walks at most 72 hours', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-06T00:02:00Z');
    const hours = (await events('MISSED_OPEN')).filter((m) => m.slot === 'current').map((m) => m.detail.slotMs);
    expect(hours).toHaveLength(72);
    expect(Math.min(...hours)).toBe(T('2026-11-03T00:00:00Z'));
  });

  it('an unlisted slot logs none', async () => {
    h.listed = 2;
    const e = engine();
    await at(e, '2026-11-01T00:06:00Z');
    expect((await events('MISSED_OPEN')).map((m) => m.slot).sort()).toEqual(['current', 'next']);
  });
});

describe('stops survive failure', () => {
  const stopSql = 'UPDATE pulse_cohorts SET call_sl_at';
  const callLeg = (id: string, grid: number) =>
    q(`SELECT sl_hit FROM pulse_leg_snapshots WHERE cohort_id = $1 AND leg = 'call' AND grid_ms = $2`, [id, grid]);

  it('markStop fails once, the ask falls back, the retry still sets the stop at the grid it was hit', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    const symbol = `C-88000-${E_NOV1}`;
    h.ask.set(symbol, 200);
    h.mark.set(symbol, 190);
    h.failSql = stopSql;
    await at(e, '2026-11-01T00:15:00Z');
    expect(e.status().lastError).toContain('db down');
    h.failSql = null;
    h.ask.set(symbol, 110);
    await at(e, '2026-11-01T00:16:00Z');
    expect(e.status().lastError).toBeNull();
    const c = (await store.liveCohorts()).find((r) => r.slot === 'current')!;
    expect(c.call_sl_at).toBe(T('2026-11-01T00:15:00Z'));
    expect(await callLeg(c.id, T('2026-11-01T00:15:00Z'))).toMatchObject([{ sl_hit: true }]);
  });

  it('a later snapshot in a new process heals a stop the row recorded, and sl_hit stays true', async () => {
    const a = engine();
    await at(a, '2026-11-01T00:00:00Z');
    await at(a, '2026-11-01T00:15:00Z');
    a.stop();
    const seeded = (await store.liveCohorts()).find((r) => r.slot === 'current')!;
    await pool.query(`UPDATE pulse_leg_snapshots SET sl_hit = true WHERE cohort_id = $1 AND leg = 'call'`, [seeded.id] as never);
    vi.setSystemTime(T('2026-11-01T00:30:00Z'));
    const b = engine();
    await b.start();
    const c = (await store.liveCohorts()).find((r) => r.slot === 'current')!;
    expect(c.call_sl_at).toBe(T('2026-11-01T00:15:00Z'));
    expect(await callLeg(c.id, T('2026-11-01T00:30:00Z'))).toMatchObject([{ sl_hit: true }]);
  });
});

describe('partial grid after a crash', () => {
  async function crashPartWay(a: Engine) {
    await at(a, '2026-11-01T00:00:00Z');
    await at(a, '2026-11-01T00:15:00Z');
    a.stop();
    const next = (await store.liveCohorts()).find((c) => c.slot === 'next')!;
    await pool.query('DELETE FROM pulse_cohort_snapshots WHERE cohort_id = $1 AND grid_ms = $2', [next.id, T('2026-11-01T00:15:00Z')] as never);
    await pool.query('DELETE FROM pulse_leg_snapshots WHERE cohort_id = $1 AND grid_ms = $2', [next.id, T('2026-11-01T00:15:00Z')] as never);
    return next;
  }

  it('restart in the same grid re-runs it, filling only the missing cohort', async () => {
    const next = await crashPartWay(engine());
    expect(await count('FROM pulse_cohort_snapshots')).toBe(2);
    vi.setSystemTime(T('2026-11-01T00:17:00Z'));
    await engine().start();
    expect(await count('FROM pulse_cohort_snapshots WHERE grid_ms = $1', [T('2026-11-01T00:15:00Z')])).toBe(3);
    expect(await count('FROM pulse_leg_snapshots')).toBe(6);
    expect(await count('FROM pulse_cohort_snapshots WHERE cohort_id = $1', [next.id])).toBe(1);
    expect(await events('SNAPSHOT_GAP')).toHaveLength(0);
  });

  it('restart after the clock moved on logs SNAPSHOT_GAP and does not back-fill', async () => {
    const next = await crashPartWay(engine());
    vi.setSystemTime(T('2026-11-01T00:31:00Z'));
    await engine().start();
    expect((await events('SNAPSHOT_GAP')).map((g) => g.detail)).toEqual([{ from: T('2026-11-01T00:00:00Z'), to: T('2026-11-01T00:30:00Z') }]);
    const grids = (await q('SELECT grid_ms FROM pulse_cohort_snapshots WHERE cohort_id = $1', [next.id])).map((r) => Number(r.grid_ms));
    expect(grids).toEqual([T('2026-11-01T00:30:00Z')]);
    expect(await count('FROM pulse_cohort_snapshots WHERE grid_ms = $1', [T('2026-11-01T00:30:00Z')])).toBe(3);
  });
});

describe('incomplete chain', () => {
  it('a transient missing Next expiry closes and opens nothing, then carries on in the same series', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    const before = await store.liveCohorts();
    h.hidden.add(E_NOV2); // would shift n2n's expiry into next and roll next and n2n
    await at(e, '2026-11-01T00:15:00Z');
    await at(e, '2026-11-01T01:00:00Z');
    expect(e.status().dataOk).toBe(false);
    expect(await count('FROM pulse_cohorts')).toBe(3);
    expect(await count(`FROM pulse_cohorts WHERE status = 'open'`)).toBe(3);
    expect(await count('FROM pulse_cohort_snapshots')).toBe(0);
    expect(await events('CHAIN_INCOMPLETE')).toMatchObject([{ detail: { missing: [E_NOV2] } }]);
    expect(await events('SLOT_MISSING')).toHaveLength(0);
    expect(e.status().slots.next).toMatchObject({ expiryMs: E_NOV2, live: 1 });

    h.hidden.clear();
    await at(e, '2026-11-01T01:01:00Z');
    expect(e.status().dataOk).toBe(true);
    const after = await store.liveCohorts();
    expect(after).toHaveLength(6);
    expect([...new Set(after.map((c) => c.series_id))].sort()).toEqual(before.map((c) => c.series_id).sort());
    expect(await count('FROM pulse_cohort_snapshots WHERE grid_ms = $1', [T('2026-11-01T01:00:00Z')])).toBe(3);
  });

  it('CHAIN_INCOMPLETE logs once per outage and again for a new one', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.hidden.add(E_NOV2);
    await at(e, '2026-11-01T00:01:00Z');
    await at(e, '2026-11-01T00:02:00Z');
    h.hidden.clear();
    await at(e, '2026-11-01T00:03:00Z');
    h.hidden.add(E_NOV3);
    await at(e, '2026-11-01T00:04:00Z');
    expect(await events('CHAIN_INCOMPLETE')).toHaveLength(2);
  });

  it('an unlisted expiry with no live cohort is not incomplete', async () => {
    h.hidden.add(E_NOV2);
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    expect(e.status().dataOk).toBe(true);
    expect(await events('CHAIN_INCOMPLETE')).toHaveLength(0);
  });
});

describe('same-grid cohorts', () => {
  it('a restart inside the open grid never snapshots a cohort at or before its own slot', async () => {
    const a = engine();
    await at(a, '2026-11-01T00:00:00Z');
    a.stop();
    vi.setSystemTime(T('2026-11-01T00:10:00Z'));
    const b = engine();
    await b.start();
    expect(await count('FROM pulse_leg_snapshots')).toBe(0);
    await at(b, '2026-11-01T00:15:00Z');
    expect(await count('FROM pulse_cohort_snapshots')).toBe(3);
    expect(await count('FROM pulse_leg_snapshots WHERE minutes_since_entry < 0')).toBe(0);
  });
});

describe('resilience', () => {
  it('a DB error in a tick is recorded, not thrown, and the next tick retries the grid', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.failSql = 'INSERT INTO pulse_cohort_snapshots';
    await expect(at(e, '2026-11-01T00:15:00Z')).resolves.toBeUndefined();
    expect(e.status().lastError).toContain('db down');
    expect(e.status().dataOk).toBe(false);
    expect(e.status().lastTickAt).toBe(T('2026-11-01T00:15:00Z'));
    expect(e.status().lastGoodTickAt).toBe(T('2026-11-01T00:00:00Z'));
    h.failSql = null;
    await at(e, '2026-11-01T00:16:00Z');
    expect(e.status().dataOk).toBe(true);
    expect(e.status().lastGoodTickAt).toBe(T('2026-11-01T00:16:00Z'));
    expect(e.status().lastError).toBeNull();
    expect(await count('FROM pulse_cohort_snapshots')).toBe(3);
    expect(await count('FROM pulse_leg_snapshots')).toBe(6);
    expect(await events('SNAPSHOT_GAP')).toHaveLength(0);
  });

  it('a DB error while opening is retried on the next tick', async () => {
    const e = engine();
    h.failSql = 'INSERT INTO pulse_cohorts';
    await at(e, '2026-11-01T00:00:00Z');
    h.failSql = null;
    await at(e, '2026-11-01T00:01:00Z');
    expect(await count('FROM pulse_cohorts')).toBe(3);
  });

  it('a retried gap grid logs SNAPSHOT_GAP once', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    await at(e, '2026-11-01T00:15:00Z');
    h.chainDown = true;
    await at(e, '2026-11-01T00:30:00Z');
    h.chainDown = false;
    h.failSql = 'INSERT INTO pulse_cohort_snapshots';
    await at(e, '2026-11-01T00:45:00Z');
    h.failSql = null;
    await at(e, '2026-11-01T00:46:00Z');
    expect(await events('SNAPSHOT_GAP')).toHaveLength(1);
  });

  it('DB_SIZE logs on the first healthy tick of each UTC hour', async () => {
    const e = engine();
    h.chainDown = true;
    await at(e, '2026-11-01T00:00:00Z');
    expect(await events('DB_SIZE')).toHaveLength(0);
    h.chainDown = false;
    await at(e, '2026-11-01T00:02:00Z');
    await at(e, '2026-11-01T00:03:00Z');
    const logged = await events('DB_SIZE');
    expect(logged).toHaveLength(1);
    expect(logged[0].detail.bytes).toBe(e.status().dbSizeBytes);
    await at(e, '2026-11-01T01:00:00Z');
    expect(await events('DB_SIZE')).toHaveLength(2);
  });
});

describe('market snapshots', () => {
  const GRID0 = T('2026-11-01T00:15:00Z');
  const marketCount = () => count('FROM pulse_market_snapshots');

  it('a grid tick writes one row per resolved slot, even with no live cohort', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:15:00Z'); // first tick: no cohort exists yet at this point of the tick
    const rows = await store.marketRowsAt(GRID0);
    expect(rows.map((r) => r.slot).sort()).toEqual(['current', 'n2n', 'next']);
    expect(rows.find((r) => r.slot === 'current')).toMatchObject({ expiry_ms: E_NOV1, spot: 80_000, sampled_ms: GRID0 });
  });

  it('writes one set per grid, not per tick', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:15:00Z');
    await at(e, '2026-11-01T00:16:00Z');
    expect(await marketCount()).toBe(3);
    await at(e, '2026-11-01T00:30:00Z');
    expect(await marketCount()).toBe(6);
  });

  it('only resolved slots get rows', async () => {
    h.listed = 1;
    const e = engine();
    await at(e, '2026-11-01T00:15:00Z');
    expect((await store.marketRowsAt(GRID0)).map((r) => r.slot)).toEqual(['current']);
  });

  it('a stale tick, an incomplete chain and a frozen feed write none', async () => {
    const e = engine();
    h.chainAgeMs = 10 * 60_000;
    await at(e, '2026-11-01T00:15:00Z');
    expect(await marketCount()).toBe(0);
    h.chainAgeMs = 0;
    await at(e, '2026-11-01T00:00:00Z'); // opens cohorts
    await pool.query('DELETE FROM pulse_market_snapshots');
    h.hidden.add(E_NOV2);
    await at(e, '2026-11-01T00:30:00Z');
    expect(await events('CHAIN_INCOMPLETE')).toHaveLength(1);
    expect(await marketCount()).toBe(0);
    h.hidden.clear();
    await at(e, '2026-11-01T00:40:00Z'); // healthy again: the 00:30 grid is written
    expect(await marketCount()).toBe(3);
    h.frozen = true;
    for (let i = 41; i <= 46; i++) await at(e, `2026-11-01T00:${i}:00Z`); // the 00:45 grid arrives with the feed frozen
    expect(await events('FEED_FROZEN')).toHaveLength(1);
    expect(await marketCount()).toBe(3);
  });

  it('a failed market write does not stop leg snapshots, is recorded, and is retried on the next tick of that grid', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    await pool.query('DELETE FROM pulse_market_snapshots');
    h.failSql = 'INSERT INTO pulse_market_snapshots';
    await expect(at(e, '2026-11-01T00:15:00Z')).resolves.toBeUndefined();
    expect(await count('FROM pulse_cohort_snapshots WHERE grid_ms = $1', [GRID0])).toBe(3);
    expect(await count('FROM pulse_leg_snapshots WHERE grid_ms = $1', [GRID0])).toBe(6);
    expect(await marketCount()).toBe(0);
    expect(e.status().lastError).toContain('market snapshot write failed');
    expect(e.status().lastGoodTickAt).toBe(T('2026-11-01T00:00:00Z'));
    h.failSql = null;
    await at(e, '2026-11-01T00:16:00Z');
    expect(await marketCount()).toBe(3);
    expect(e.status().lastError).toBeNull();
    expect(e.status().lastGoodTickAt).toBe(T('2026-11-01T00:16:00Z'));
    expect(await count('FROM pulse_cohort_snapshots')).toBe(3);
  });
});

describe('minute rows', () => {
  const MIN1 = T('2026-11-01T00:01:00Z');
  const minuteCount = () => count('FROM pulse_minute');

  it('saves one row per slot on a healthy tick', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z'); // opens the cohorts, so nothing to follow yet
    expect(await minuteCount()).toBe(0);
    await at(e, '2026-11-01T00:01:30Z');
    const rows = await q('SELECT * FROM pulse_minute ORDER BY slot');
    expect(rows.map((r) => r.slot)).toEqual(['current', 'n2n', 'next']);
    const cur = rows.find((r) => r.slot === 'current');
    expect(Number(cur.t)).toBe(MIN1);
    expect(Number(cur.cohort_id)).toBe(T('2026-11-01T00:00:00Z'));
    expect(cur).toMatchObject({ data_ok: true });
    expect(Number(cur.fut_price)).toBe(80_000);
    expect(Number(cur.call_mid)).toBe(105);
    expect(Number(cur.put_mid)).toBe(95);
    expect(Number(cur.call_iv)).toBe(40);
    expect(Number(cur.put_iv)).toBe(41);
    await at(e, '2026-11-01T00:01:50Z'); // same minute again: no duplicate
    expect(await minuteCount()).toBe(3);
  });

  it('stores a missing quote as null with data_ok false', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.gone.add(`P-72000-${E_NOV1}`);
    await at(e, '2026-11-01T00:01:00Z');
    const cur = (await q(`SELECT * FROM pulse_minute WHERE slot = 'current'`))[0];
    expect(cur.put_mid).toBeNull();
    expect(cur.put_iv).toBeNull();
    expect(cur.data_ok).toBe(false);
    expect(Number(cur.call_mid)).toBe(105);
  });

  it('saves nothing on a stale tick', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.chainAgeMs = 10 * 60_000;
    await at(e, '2026-11-01T00:01:00Z');
    expect(await minuteCount()).toBe(0);
  });

  it('a failed minute write leaves the 15-minute snapshot intact', async () => {
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    h.failSql = 'INSERT INTO pulse_minute';
    await expect(at(e, '2026-11-01T00:15:00Z')).resolves.toBeUndefined();
    expect(await count('FROM pulse_cohort_snapshots WHERE grid_ms = $1', [T('2026-11-01T00:15:00Z')])).toBe(3);
    expect(await minuteCount()).toBe(0);
    expect(console.error).toHaveBeenCalledWith('[pulse]', expect.stringContaining('minute write failed'));
    h.failSql = null;
    await at(e, '2026-11-01T00:16:00Z');
    expect(await minuteCount()).toBe(3);
  });

  it('deletes rows past 45 days once an hour', async () => {
    const day = 86_400_000;
    const now = T('2026-11-01T00:00:00Z');
    const seed = (t: number) => pool.query(
      `INSERT INTO pulse_minute (slot, cohort_id, t, data_ok) VALUES ('current', 1, $1, true)`, [t],
    );
    await seed(now - 46 * day);
    await seed(now - 44 * day);
    const e = engine();
    await at(e, '2026-11-01T00:00:00Z');
    expect((await q('SELECT t FROM pulse_minute')).map((r) => Number(r.t))).toEqual([now - 44 * day]);
    await seed(now - 47 * day);
    await at(e, '2026-11-01T00:30:00Z');
    expect(await count('FROM pulse_minute WHERE t < $1', [now - 45 * day])).toBe(1);
    await at(e, '2026-11-01T01:00:00Z');
    expect(await count('FROM pulse_minute WHERE t < $1', [now - 45 * day])).toBe(0);
  });
});
