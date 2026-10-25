import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { ChainOption } from '../../lib/bot/strike-picker.js';
import type { Book, ChainSnapshot } from './delta-public.js';

/**
 * Engine integration test on a real Postgres (PGlite, WASM) with Delta market data and the gate
 * mocked. Time is controlled via Date only, so the 5-second timer never runs: ticks are manual.
 */
const h = vi.hoisted(() => ({ db: null as unknown as { query: Function; exec: Function }, marks: new Map<string, number>(), ivs: new Map<string, number>(), gateGo: true }));

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

vi.mock('./gate.js', () => ({
  evaluateGate: () => ({
    version: 'v1', go: h.gateGo, reasons: h.gateGo ? [] : ['test: WAIT'], dvol: 50, macroZone: 'calm', macroScore: 10,
    nextEvent: 'No Tier-1 in 6h', eventInWindow: false,
  }),
}));

const MS_DAY = 86_400_000;
const E1 = Date.parse('2026-10-26T12:00:00Z');
const E2 = E1 + MS_DAY;
const E3 = E2 + MS_DAY;
const EXPIRIES = [E1, E2, E3]; // index 0 = current (filler), 1 = next (ATM straddles), 2 = N2N (short bodies)
const SPOT = 80_800;

const spec: Array<[string, 'call' | 'put', number, number, number]> = [
  // symbol, type, strike, abs delta, expiry
  ['C-BODY', 'call', 82500, 0.12, E3],
  ['P-BODY', 'put', 78500, 0.13, E3],
  ['C-ATM', 'call', 80800, 0.5, E2],
  ['P-ATM', 'put', 80800, 0.5, E2],
  // calendar fixtures: the same ATM strike on the current (E1) and N2N (E3) expiries
  ['C-CF', 'call', 80800, 0.5, E1],
  ['P-CF', 'put', 80800, 0.5, E1],
  ['C-CB', 'call', 80800, 0.5, E3],
  ['P-CB', 'put', 80800, 0.5, E3],
];
const BASE: Record<string, number> = { 'C-BODY': 100, 'P-BODY': 90,'C-ATM': 500, 'P-ATM': 490, 'C-CF': 300, 'P-CF': 290, 'C-CB': 620, 'P-CB': 610 };

function chain(): ChainSnapshot {
  const options: ChainOption[] = spec.map(([symbol, type, strike, delta, expiryMs]) => {
    const mark = h.marks.get(symbol) ?? BASE[symbol]!;
    return { symbol, type, strike, expiryMs, delta, bid: mark - 2, ask: mark + 2, mark, iv: h.ivs.get(symbol) ?? 40 };
  });
  return { fetchedAt: Date.now(), spot: SPOT, options, greeks: new Map(options.map((o) => [o.symbol, { delta: o.delta, gamma: 1e-5, theta: -10, vega: 20 }])), expiries: EXPIRIES };
}

vi.mock('./delta-public.js', () => ({
  DEFAULT_PERP: { symbol: 'BTCUSD', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, maxLeverage: 200, tick: 0.5 },
  fetchCandles: async () => [],
  fetchPerpInfo: async () => ({ symbol: 'BTCUSD', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, maxLeverage: 200, tick: 0.5 }),
  fetchChain: async () => chain(),
  fetchBook: async (symbol: string): Promise<Book> => {
    const mark = h.marks.get(symbol) ?? BASE[symbol]!;
    return { bids: [[mark - 2, 500], [mark - 3, 500]], asks: [[mark + 2, 500], [mark + 3, 500]] };
  },
  fetchOptionFeeRates: async (symbols: string[]) =>
    new Map(symbols.map((s) => [s, { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 }])),
}));

const { BotEngine } = await import('./bot-engine.js');
const store = await import('./bot-store.js');
const { pool } = await import('../../db/index.js');

const istToUtc = (date: string, hh: number, mm: number, ss = 0) => Date.parse(`${date}T00:00:00Z`) - 19_800_000 + ((hh * 60 + mm) * 60 + ss) * 1000;

async function newEngine() {
  process.env.BOT_ENABLED = 'true';
  const e = new BotEngine();
  await store.ensureBotSchema();
  await (e as any).restore();
  (e as any).status = 'running';
  return e;
}

const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params as never)).rows as any[];

beforeAll(async () => {
  process.env.BOT_FUTURES = 'false'; // the futures engine has its own test file
  h.db = new PGlite() as never;
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  h.marks.clear();
  h.ivs.clear();
  h.gateGo = true;
  await store.ensureBotSchema();
  await pool.query('DELETE FROM bot_minute_marks; DELETE FROM bot_minute_context; DELETE FROM bot_events; DELETE FROM bot_fills; DELETE FROM bot_legs; DELETE FROM bot_runs;');
  await store.setConfig({ paused: false, killSwitch: false });
});

describe('bot engine on a real Postgres', () => {
  it('enters both books of ASIA_SHORT at 10:00 IST, once, and records the minute', async () => {
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e.tick();
    await e.tick(); // same minute again: idempotent

    const runs = await q('SELECT strategy, book, status, margin_usd FROM bot_runs ORDER BY run_key');
    expect(runs.map((r) => `${r.strategy}:${r.book}:${r.status}`)).toEqual(['ASIA_SHORT:always:open', 'ASIA_SHORT:gated:open']);
    expect(Number(runs[0]!.margin_usd)).toBeGreaterThan(0);

    const legs = await q(`SELECT l.symbol, l.side, l.role, l.entry_price FROM bot_legs l JOIN bot_runs r ON r.id = l.run_id WHERE r.run_key = 'ASIA_SHORT:2026-10-26:always' ORDER BY l.id`);
    expect(legs.map((l) => `${l.side}:${l.role}:${l.symbol}`)).toEqual(['short:body:C-BODY', 'short:body:P-BODY']);
    // shorts sell into bids (mark-2) with a 1-tick pad against us
    expect(Number(legs[0]!.entry_price)).toBeCloseTo(98 - 0.5, 6);

    expect((await q('SELECT COUNT(*)::int AS n FROM bot_fills'))[0].n).toBe(4);
    const marks = await q('SELECT COUNT(*)::int AS n FROM bot_minute_marks');
    expect(marks[0].n).toBe(2);
    expect((await q('SELECT COUNT(*)::int AS n FROM bot_minute_context'))[0].n).toBe(1);
    const snap = (await q('SELECT snapshot FROM bot_minute_marks LIMIT 1'))[0].snapshot;
    expect(snap.legs[0]).toMatchObject({ symbol: expect.any(String), delta: expect.any(Number), vega: 20 });
    expect(snap.tpTargetUsd).toBeGreaterThan(0);
  });

  it('one short leg doubling stops and closes every leg of the position', async () => {
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e.tick();
    h.marks.set('C-BODY', 210); // above 2x the ~97.5 entry
    vi.setSystemTime(istToUtc('2026-10-26', 10, 5, 0));
    await e.tick();

    const runs = await q(`SELECT run_key, status, exit_reason, net_pnl, fees_exit FROM bot_runs WHERE strategy = 'ASIA_SHORT' ORDER BY run_key`);
    expect(runs.every((r) => r.status === 'closed' && r.exit_reason === 'stop')).toBe(true);
    expect(Number(runs[0]!.net_pnl)).toBeLessThan(0);
    expect(Number(runs[0]!.fees_exit)).toBeGreaterThan(0);
    const legs = await q(`SELECT exit_price FROM bot_legs l JOIN bot_runs r ON r.id = l.run_id WHERE r.run_key = 'ASIA_SHORT:2026-10-26:always'`);
    expect(legs.every((l) => l.exit_price != null)).toBe(true);
    expect(await q(`SELECT 1 FROM bot_events WHERE type = 'exit'`)).not.toHaveLength(0);
  });

  it('time-exits ASIA_SHORT at 16:00 IST', async () => {
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e.tick();
    vi.setSystemTime(istToUtc('2026-10-26', 15, 59, 0));
    await e.tick();
    expect((await q(`SELECT COUNT(*)::int AS n FROM bot_runs WHERE status = 'open'`))[0].n).toBe(2);
    vi.setSystemTime(istToUtc('2026-10-26', 16, 0, 5));
    await e.tick();
    const st = await q(`SELECT status, exit_reason FROM bot_runs`);
    expect(st.every((r) => r.status === 'closed' && r.exit_reason === 'time')).toBe(true);
  });

  it('the gated book waits on WAIT while the always book trades; it enters later in the window once the gate is GO', async () => {
    h.gateGo = false;
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 22, 30, 20));
    await e.tick();
    let runs = await q(`SELECT run_key, status FROM bot_runs WHERE strategy = 'NY_SHORT' ORDER BY run_key`);
    // no placeholder row while it is still waiting: only the always book exists
    expect(runs).toEqual([{ run_key: 'NY_SHORT:2026-10-26:always', status: 'open' }]);
    expect(e.waitingEntries()).toMatchObject([{ key: 'NY_SHORT:2026-10-26:gated', attempts: 1, lastReason: expect.stringContaining('gate WAIT') }]);
    expect(await q(`SELECT 1 FROM bot_events WHERE type = 'entry_waiting'`)).toHaveLength(1);

    // the gate stays WAIT: a minute later it re-checks but does not repeat the same reason
    vi.setSystemTime(istToUtc('2026-10-26', 22, 31, 20));
    await e.tick();
    expect(await q(`SELECT 1 FROM bot_events WHERE type = 'entry_waiting'`)).toHaveLength(1);
    expect(e.waitingEntries()[0]!.attempts).toBe(2);

    // 50 minutes in the gate turns GO: it enters then, and says how long it waited
    h.gateGo = true;
    vi.setSystemTime(istToUtc('2026-10-27', 0, 20, 20));
    await e.tick();
    runs = await q(`SELECT run_key, status, tags FROM bot_runs WHERE strategy = 'NY_SHORT' ORDER BY run_key`);
    expect(runs.map((r) => `${r.run_key}:${r.status}`)).toEqual(['NY_SHORT:2026-10-26:always:open', 'NY_SHORT:2026-10-26:gated:open']);
    expect(runs[1]!.tags.enteredAfterWaitMin).toBe(110);
    expect(runs[1]!.tags.reasonsBeforeEntry[0].reason).toMatch(/gate WAIT/);
    expect(e.waitingEntries()).toHaveLength(0);
    // the forced exit time did not move
    const planned = await q(`SELECT planned_exit_at FROM bot_runs WHERE run_key = 'NY_SHORT:2026-10-26:gated'`);
    expect(new Date(planned[0].planned_exit_at).getTime()).toBe(istToUtc('2026-10-27', 7, 0));
  });

  it('a gated entry that never gets a GO within the window is recorded as dropped, with the reasons seen', async () => {
    h.gateGo = false;
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e.tick();
    vi.setSystemTime(istToUtc('2026-10-26', 11, 30, 20));
    await e.tick();
    expect(await q(`SELECT 1 FROM bot_runs WHERE run_key = 'ASIA_SHORT:2026-10-26:gated'`)).toHaveLength(0); // still inside the 2h window
    vi.setSystemTime(istToUtc('2026-10-26', 11, 59, 20));
    await e.tick();
    const r = (await q(`SELECT status, tags FROM bot_runs WHERE run_key = 'ASIA_SHORT:2026-10-26:gated'`))[0];
    expect(r.status).toBe('skipped');
    expect(r.tags.reason).toMatch(/gate WAIT/);
    expect(r.tags.attempts).toBe(3); // one try per ticked minute here (10:00, 11:30, 11:59)
    expect(r.tags.reasonsSeen).toHaveLength(1);
    expect(await q(`SELECT 1 FROM bot_events WHERE type = 'entry_skipped' AND message LIKE '%dropped%'`)).toHaveLength(1);
    // the window is closed: it is never retried
    vi.setSystemTime(istToUtc('2026-10-26', 12, 5, 0));
    await e.tick();
    expect((await q(`SELECT COUNT(*)::int AS n FROM bot_runs WHERE run_key = 'ASIA_SHORT:2026-10-26:gated'`))[0].n).toBe(1);
  });

  it('the New York window is 3h: still waiting at 2h58, dropped in its last minute (01:29 IST)', async () => {
    h.gateGo = false;
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 22, 30, 20));
    await e.tick();
    vi.setSystemTime(istToUtc('2026-10-27', 1, 28, 20));
    await e.tick();
    expect(await q(`SELECT 1 FROM bot_runs WHERE run_key = 'NY_SHORT:2026-10-26:gated'`)).toHaveLength(0);
    expect(e.waitingEntries()).toHaveLength(1);
    vi.setSystemTime(istToUtc('2026-10-27', 1, 29, 20));
    await e.tick();
    expect(await q(`SELECT 1 FROM bot_runs WHERE run_key = 'NY_SHORT:2026-10-26:gated' AND status = 'skipped'`)).toHaveLength(1);
    expect(e.waitingEntries()).toHaveLength(0);
  });

  it('long straddles enter on the next expiry ATM strike, always book only', async () => {
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 17, 30, 20));
    await e.tick();
    const runs = await q(`SELECT run_key FROM bot_runs WHERE strategy = 'EVE_LONG'`);
    expect(runs.map((r) => r.run_key)).toEqual(['EVE_LONG:2026-10-26:always']);
    const legs = await q(`SELECT symbol, side FROM bot_legs l JOIN bot_runs r ON r.id = l.run_id WHERE r.strategy = 'EVE_LONG' ORDER BY l.id`);
    expect(legs).toEqual([{ symbol: 'C-ATM', side: 'long' }, { symbol: 'P-ATM', side: 'long' }]);
  });

  it('a long straddle takes profit at +50% of its premium-based margin', async () => {
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 17, 30, 20));
    await e.tick();
    h.marks.set('C-ATM', 1000);
    vi.setSystemTime(istToUtc('2026-10-26', 17, 40, 0));
    await e.tick();
    const r = (await q(`SELECT status, exit_reason, net_pnl FROM bot_runs WHERE strategy = 'EVE_LONG'`))[0];
    expect(r).toMatchObject({ status: 'closed', exit_reason: 'tp' });
    expect(Number(r.net_pnl)).toBeGreaterThan(0);
  });

  it('the kill switch flattens everything and blocks new entries; pause blocks entries only', async () => {
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e.tick();
    await store.setConfig({ killSwitch: true });
    vi.setSystemTime(istToUtc('2026-10-26', 10, 1, 0));
    await e.tick();
    expect((await q(`SELECT COUNT(*)::int AS n FROM bot_runs WHERE status = 'open'`))[0].n).toBe(0);
    expect((await q(`SELECT DISTINCT exit_reason FROM bot_runs WHERE status = 'closed'`))[0].exit_reason).toBe('stop');

    await store.setConfig({ killSwitch: false, paused: true });
    vi.setSystemTime(istToUtc('2026-10-26', 22, 30, 20));
    await e.tick();
    expect(await q(`SELECT 1 FROM bot_runs WHERE strategy = 'NY_SHORT'`)).toHaveLength(0);
  });

  it('calendar: enters at 18:00 IST only in backwardation, as short front / long N2N at the ATM strike', async () => {
    h.ivs.set('C-CF', 58); h.ivs.set('P-CF', 58); h.ivs.set('C-CB', 40); h.ivs.set('P-CB', 40);
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-25', 18, 0, 20));
    await e.tick();
    const run = (await q(`SELECT id, status, margin_usd, planned_exit_at, exit_config FROM bot_runs WHERE strategy = 'CAL_BACK'`))[0];
    expect(run.status).toBe('open');
    const legs = await q('SELECT symbol, side, role FROM bot_legs WHERE run_id = $1 ORDER BY id', [run.id]);
    expect(legs.map((l) => `${l.side}:${l.role}:${l.symbol}`)).toEqual(['short:front:C-CF', 'short:front:P-CF', 'long:back:C-CB', 'long:back:P-CB']);
    // exit config carries a breakeven band around spot and a hard close an hour before the front expiry
    expect(run.exit_config.breakeven.low).toBeLessThan(80_800);
    expect(run.exit_config.breakeven.high).toBeGreaterThan(80_800);
    expect(run.exit_config.hardCloseAtMs).toBe(E1 - 3_600_000);
    expect(new Date(run.planned_exit_at).getTime()).toBe(E1 - 3_600_000);
    expect(Number(run.margin_usd)).toBeGreaterThan(0);
  });

  it('calendar: records a skipped run (with the reason) when the curve is not in backwardation', async () => {
    h.ivs.set('C-CF', 38); h.ivs.set('P-CF', 38); h.ivs.set('C-CB', 45); h.ivs.set('P-CB', 45);
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-25', 18, 1, 0));
    await e.tick();
    const run = (await q(`SELECT status, tags FROM bot_runs WHERE strategy = 'CAL_BACK'`))[0];
    expect(run.status).toBe('skipped');
    expect(run.tags.reason).toMatch(/no backwardation/);
    expect(await q(`SELECT 1 FROM bot_events WHERE type = 'entry_skipped' AND message LIKE '%no backwardation%'`)).not.toHaveLength(0);
  });

  it('calendar: exits when spot leaves the breakeven band, closing all four legs', async () => {
    h.ivs.set('C-CF', 58); h.ivs.set('P-CF', 58); h.ivs.set('C-CB', 40); h.ivs.set('P-CB', 40);
    const e = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-25', 18, 0, 20));
    await e.tick();
    // a move far outside the profit zone: the short front straddle blows out, long back barely moves
    h.marks.set('C-CF', 2200); h.marks.set('C-CB', 2600); h.marks.set('P-CF', 5); h.marks.set('P-CB', 120);
    vi.setSystemTime(istToUtc('2026-10-25', 18, 30, 0));
    // spot is a constant in this fixture, so force the breakeven check by tightening the stored band
    await pool.query(`UPDATE bot_runs SET exit_config = jsonb_set(exit_config, '{breakeven}', '{"low": 70000, "high": 80000}') WHERE strategy = 'CAL_BACK'`);
    await (e as any).restore();
    await e.tick();
    const run = (await q(`SELECT status, exit_reason FROM bot_runs WHERE strategy = 'CAL_BACK'`))[0];
    expect(run).toMatchObject({ status: 'closed', exit_reason: 'breakeven' });
    expect((await q(`SELECT COUNT(*)::int AS n FROM bot_legs l JOIN bot_runs r ON r.id = l.run_id WHERE r.strategy = 'CAL_BACK' AND l.exit_price IS NOT NULL`))[0].n).toBe(4);
  });

  it('restores open runs after a restart without re-entering', async () => {
    const e1 = await newEngine();
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e1.tick();
    const e2 = await newEngine(); // simulates a process restart
    vi.setSystemTime(istToUtc('2026-10-26', 10, 2, 0));
    await e2.tick();
    expect((await q('SELECT COUNT(*)::int AS n FROM bot_runs'))[0].n).toBe(2);
    const live = await e2.livePositions();
    expect(live).toHaveLength(2);
    expect(live[0]!.pnl).not.toBeNull();
  });

  it('keeps retrying when no strike is tradable, and records the day as failed only when the 2h window ends', async () => {
    const e = await newEngine();
    h.marks.set('C-BODY', 1); // bid becomes -1 -> unfillable quote, picker skips it, so no tradable call
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e.tick();
    expect(await q(`SELECT 1 FROM bot_runs WHERE strategy = 'ASIA_SHORT'`)).toHaveLength(0);
    expect(e.waitingEntries()).toHaveLength(2);

    // the quote recovers 40 minutes in: both books enter then
    h.marks.delete('C-BODY');
    vi.setSystemTime(istToUtc('2026-10-26', 10, 40, 20));
    await e.tick();
    const r = await q(`SELECT status, tags FROM bot_runs WHERE strategy = 'ASIA_SHORT'`);
    expect(r.map((x) => x.status)).toEqual(['open', 'open']);
    expect(r[0]!.tags.enteredAfterWaitMin).toBe(40);
    expect(r[0]!.tags.reasonsBeforeEntry[0].reason).toMatch(/no tradable strikes/);
  });

  it('marks the day failed with the reason (and never re-tries it) when strikes stay untradable through the window', async () => {
    const e = await newEngine();
    h.marks.set('C-BODY', 1);
    vi.setSystemTime(istToUtc('2026-10-26', 10, 0, 20));
    await e.tick();
    vi.setSystemTime(istToUtc('2026-10-26', 11, 59, 20));
    await e.tick();
    const r = await q(`SELECT status, tags FROM bot_runs WHERE strategy = 'ASIA_SHORT'`);
    expect(r.map((x) => x.status)).toEqual(['failed', 'failed']);
    expect(r[0]!.tags.reason).toMatch(/no tradable strikes/);
    await e.tick();
    expect((await q(`SELECT COUNT(*)::int AS n FROM bot_runs WHERE strategy = 'ASIA_SHORT'`))[0].n).toBe(2);
    expect(await q(`SELECT 1 FROM bot_events WHERE type = 'entry_failed'`)).not.toHaveLength(0);
  });

  it('a long straddle gets no wait window: a failure at its time is recorded at once', async () => {
    const e = await newEngine();
    h.marks.set('C-ATM', -5); // ask below zero: not a tradable quote
    vi.setSystemTime(istToUtc('2026-10-26', 17, 30, 20));
    await e.tick();
    const r = await q(`SELECT status FROM bot_runs WHERE strategy = 'EVE_LONG'`);
    expect(r).toEqual([{ status: 'failed' }]);
  });
});
