import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

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

const { answer } = await import('./answer.js');
const { GLOSSARY } = await import('../../lib/ask/glossary.js');
const { ensureBotSchema } = await import('../bot/bot-store.js');
const { pool } = await import('../../db/index.js');

const NOW = Date.parse('2026-10-28T06:30:00Z'); // Wed 12:00 IST
const IST = 19_800_000;
const istMs = (date: string, hh: number, mm = 0) => Date.parse(`${date}T00:00:00Z`) - IST + (hh * 60 + mm) * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const live = (over: Record<string, unknown> = {}) => ({
  botEnabled: () => true,
  botStatus: () => ({ engine: 'running', mode: 'paper', lastTickAt: NOW, lastError: null }),
  positions: async () => [] as any[],
  market: () => ({ spot: 80_800.4, mark: 80_810, funding: 0.0001, oi: 123_456, dvol: 38.1, macro: { score: 22, zone: 'calm', direction: 'RISK-ON', nextEvent: 'No Tier-1 in 6h', tradeRule: 'Normal size.' } }),
  ...over,
});
const DOCS = [{ id: 'TEST.md#0', title: 'Zebra protocol', keywords: [], text: 'The zebra protocol says to restart the striped gateway every Tuesday before the herd migrates, and to log the migration in the savanna ledger.', source: 'TEST.md' }];
const ctx = (l = live(), knowledge = () => [...GLOSSARY, ...DOCS]) => ({ q: async (sql: string, params?: unknown[]) => (await pool.query(sql, params as never)).rows, now: NOW, live: l, knowledge });

let seq = 0;
async function run(o: { strategy: string; book?: string; date: string; entry: number; exit?: number; net?: number; reason?: string; status?: string; peak?: number; trough?: number; margin?: number; feesE?: number; feesX?: number; tags?: object; detail?: string }) {
  const key = `${o.strategy}:${o.date}:${o.book ?? 'always'}:${seq++}`;
  const r = await pool.query(
    `INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, entry_at, exit_at, margin_usd, fees_entry, fees_exit, net_pnl, peak_pnl, trough_pnl, exit_reason, exit_detail, tags)
     VALUES ($1,$2,$3,'paper',$4,$5, to_timestamp($6::float8/1000.0), CASE WHEN $7::float8 IS NULL THEN NULL ELSE to_timestamp($7::float8/1000.0) END, $8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [key, o.strategy, o.book ?? 'always', o.date, o.status ?? (o.exit ? 'closed' : 'open'), o.entry, o.exit ?? null, o.margin ?? 80, o.feesE ?? 0.8, o.feesX ?? 0.8, o.net ?? null, o.peak ?? o.net ?? null, o.trough ?? o.net ?? null, o.reason ?? null, o.detail ?? null, JSON.stringify(o.tags ?? {})],
  );
  return (r.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  h.db = new PGlite() as never;
  await ensureBotSchema();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (id serial, strategy text, status text, expiry_date timestamptz, call_strike numeric, put_strike numeric, entry_time timestamptz, exit_time timestamptz, realized_pnl numeric, exit_reason text);
    CREATE TABLE IF NOT EXISTS nightly_reviews (id serial, session_date date, verdict text, outcome text, iv_1730 numeric, iv_ny_open numeric, iv_exit numeric, speed_vs_iv numeric, adx_trend text, exit_hour int, notes text);
    CREATE TABLE IF NOT EXISTS session_audit_logs (id serial, session_date date, day_name text, session_status text, outcome text, telemetry_match boolean, mismatch_reason text);
    CREATE TABLE IF NOT EXISTS recalibration_audits (id serial, run_at timestamptz, total_sessions int, in_sample_sessions int, out_of_sample_sessions int, cleared_bonferroni boolean, oos_stability_verdict text, combo_stop_rate numeric, oos_stop_rate numeric, combo_p_value numeric);
    CREATE TABLE IF NOT EXISTS alert_logs (id serial, delivered_at timestamptz, channel text, status text, title text, message text);
    CREATE TABLE IF NOT EXISTS users (id serial, email text, password_hash text);
    CREATE TABLE IF NOT EXISTS api_credentials (id serial, api_key text, api_secret text);
    CREATE TABLE IF NOT EXISTS indicator_snapshots (id serial, recorded_at timestamptz, atm_iv numeric, n2n_iv numeric, term_current_n2n numeric, term_next_n2n numeric, skew_25d numeric);
  `);
});

beforeEach(async () => {
  await pool.query('DROP TABLE IF EXISTS secret_test; CREATE TABLE secret_test (id serial, name text, api_token text, password_hash text, created_at timestamptz DEFAULT now());');
  await pool.query('DELETE FROM bot_minute_marks; DELETE FROM bot_minute_context; DELETE FROM bot_events; DELETE FROM bot_fills; DELETE FROM bot_legs; DELETE FROM bot_runs; DELETE FROM trades; DELETE FROM nightly_reviews; DELETE FROM session_audit_logs; DELETE FROM recalibration_audits; DELETE FROM alert_logs; DELETE FROM indicator_snapshots;');
});

describe('help, rules and unknown', () => {
  it('help lists what it can do and offers suggestions, without touching the database', async () => {
    const a = await answer('what can you do?', ctx());
    expect(a.intent).toBe('help');
    expect(a.text).toMatch(/only/i);
    expect(a.suggestions!.length).toBeGreaterThan(5);
  });

  it('rules explain a strategy in plain words', async () => {
    const a = await answer('what is the NY short rule?', ctx());
    expect(a.intent).toBe('rules');
    expect(a.text).toMatch(/22:30 IST/);
    expect(a.text).toMatch(/2x/);
    const f = await answer('how do the futures strategies work', ctx());
    expect(f.text).toMatch(/BTC perpetual/);
  });

  it('an unmatched question says so honestly and suggests real questions', async () => {
    const a = await answer('what will the price be next week', ctx());
    expect(a.intent).toBe('unknown');
    expect(a.text).toMatch(/could not match/);
    expect(a.text).toMatch(/do not predict/);
    expect(a.suggestions!.length).toBeGreaterThan(0);
  });
});

describe('pnl', () => {
  it('sums closed trades for the period and strategy, with win, stop and take-profit rates', async () => {
    await run({ strategy: 'NY_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 22, 30), exit: istMs('2026-10-28', 7), net: 8.3, reason: 'tp' });
    await run({ strategy: 'NY_SHORT', book: 'gated', date: '2026-10-27', entry: istMs('2026-10-27', 22, 30), exit: istMs('2026-10-28', 7), net: -12.7, reason: 'stop' });
    await run({ strategy: 'ASIA_SHORT', date: '2026-10-26', entry: istMs('2026-10-26', 10), exit: istMs('2026-10-26', 16), net: 3, reason: 'time' }); // outside "today"
    const a = await answer("Today's PnL", ctx());
    expect(a.intent).toBe('pnl');
    expect(a.text).toMatch(/-\$4\.40 over 2 closed trades/);
    expect(a.text).toMatch(/win rate 50%/);
    expect(a.text).toMatch(/stopped 50%/);
    expect(a.table!.rows).toHaveLength(2);
    expect(a.sources).toContain('bot_runs');
    const all = await answer('total pnl of the asia strangle all time', ctx());
    expect(all.text).toMatch(/\$3\.00 over 1 closed trade/);
  });

  it('says plainly when there is nothing, and adds unrealised PnL from running positions', async () => {
    const empty = await answer('pnl this week', ctx());
    expect(empty.text).toMatch(/No closed paper trades/);
    const withOpen = await answer('pnl today', ctx(live({ positions: async () => [{ strategy: 'ASIA_SHORT', book: 'always', pnl: { netPnl: 4.2 } }] })));
    expect(withOpen.text).toMatch(/running with \$4\.20 unrealised/);
  });

  it('includes manually logged trades when they exist', async () => {
    await pool.query(`INSERT INTO trades (strategy, status, entry_time, exit_time, realized_pnl) VALUES ('SHORT_STRANGLE','CLOSED', $1, $2, 25.5)`, [iso(istMs('2026-10-27', 22)), iso(istMs('2026-10-28', 7))]);
    const a = await answer('pnl today', ctx());
    expect(a.text).toMatch(/manually logged trades in the same period: 1 closed, \$25\.50/);
    expect(a.sources).toContain('trades');
  });
});

describe('explain', () => {
  it('explains the last stopped trade: entry, why it exited, PnL, give-back and fees', async () => {
    const id = await run({
      strategy: 'ASIA_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 10), exit: istMs('2026-10-27', 12, 5), net: -13.7, peak: 2.1, trough: -13.7, reason: 'stop',
      detail: 'C-82500 mark 196 reached 2x entry 98', tags: { gate: { go: true, reasons: [], dvol: 38.1, macroZone: 'calm' } },
    });
    await pool.query(`INSERT INTO bot_legs (run_id, symbol, type, side, role, strike, expiry_ms, lots, entry_price) VALUES ($1,'C-82500','call','short','body',82500,1,100,98), ($1,'P-78500','put','short','body',78500,1,100,90)`, [id]);
    await pool.query(`INSERT INTO bot_fills (run_id, leg_symbol, action, side, lots, intended_price, avg_price, filled) VALUES ($1,'C-82500','entry','sell',100,99,98,100)`, [id]);
    const a = await answer('why was the asia trade stopped?', ctx());
    expect(a.intent).toBe('explain');
    expect(a.text).toMatch(/Asia short strangle/);
    expect(a.text).toMatch(/short 100 call 82500 @ 98\.0/);
    expect(a.text).toMatch(/because a stop was hit \(C-82500 mark 196 reached 2x entry 98\)/);
    expect(a.text).toMatch(/net -\$13\.70 after \$1\.60 of fees/);
    expect(a.text).toMatch(/gave back \$15\.80 from the peak/);
    expect(a.text).toMatch(/Gate at entry: GO/);
    expect(a.text).toMatch(/slippage/);
  });

  it('picks the right strategy and date, and reports when there is nothing to explain', async () => {
    await run({ strategy: 'NY_SHORT', date: '2026-10-26', entry: istMs('2026-10-26', 22, 30), exit: istMs('2026-10-27', 7), net: 6, reason: 'tp' });
    await run({ strategy: 'ASIA_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 10), exit: istMs('2026-10-27', 16), net: -2, reason: 'time' });
    const ny = await answer('why did the ny short exit on 2026-10-26', ctx());
    expect(ny.text).toMatch(/New York short strangle/);
    expect(ny.text).toMatch(/profit target was reached/);
    const none = await answer('why was the calendar stopped', ctx());
    expect(none.text).toMatch(/found no/);
  });
});

describe('at a given minute', () => {
  it('shows positions, market context and events recorded at that IST minute', async () => {
    const id = await run({ strategy: 'ASIA_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 10), exit: istMs('2026-10-27', 16), net: 1, reason: 'time' });
    const minute = istMs('2026-10-27', 10, 5);
    await pool.query(`INSERT INTO bot_minute_marks (run_id, minute_ms, net_pnl, gross_pnl, pct_margin, spot, snapshot) VALUES ($1,$2,3.5,4.3,0.043,80810,'{}')`, [id, minute]);
    await pool.query(`INSERT INTO bot_minute_context (minute_ms, spot, ctx) VALUES ($1, 80810, $2)`, [minute, JSON.stringify({ gate: { go: false, reasons: ['DVOL 70 >= 65'], dvol: 70, macroZone: 'elevated' } })]);
    await pool.query(`INSERT INTO bot_events (at, type, message) VALUES (to_timestamp($1/1000.0), 'entry', 'ASIA_SHORT entered')`, [minute + 20_000]);
    const a = await answer('what was happening at 10:05 yesterday', ctx());
    expect(a.intent).toBe('at_time');
    expect(a.text).toMatch(/Asia short strangle \(10:00 IST\): net \$3\.50 \(4\.3% of margin\), spot 80810/);
    expect(a.text).toMatch(/gate WAIT \(DVOL 70 >= 65\)/);
    expect(a.text).toMatch(/Event: entry/);
    const none = await answer('what was happening at 03:03 yesterday', ctx());
    expect(none.text).toMatch(/no position was recorded/);
    expect(none.text).toMatch(/No market context/);
  });
});

describe('why no trade', () => {
  it('lists skipped and failed runs with their reasons, and what did trade', async () => {
    await run({ strategy: 'ASIA_SHORT', date: '2026-10-28', entry: istMs('2026-10-28', 10), net: undefined, status: 'open' });
    await run({ strategy: 'NY_SHORT', book: 'gated', date: '2026-10-28', entry: istMs('2026-10-28', 22, 30), status: 'skipped', tags: { gate: { go: false, reasons: ['DVOL 70.0 >= 65'] } } });
    await run({ strategy: 'CAL_BACK', date: '2026-10-28', entry: istMs('2026-10-28', 18), status: 'skipped', tags: { reason: 'no backwardation: front IV 38.0 vs back IV 45.0 (need +2 pts)' } });
    await pool.query(`INSERT INTO bot_events (at, strategy, type, message) VALUES (to_timestamp($1/1000.0), 'CAL_BACK', 'entry_skipped', 'CAL_BACK:2026-10-28:always: no backwardation')`, [istMs('2026-10-28', 8)]);
    const a = await answer('why no trade today?', ctx());
    expect(a.intent).toBe('why_no_trade');
    expect(a.text).toMatch(/Traded on 2026-10-28: Asia short strangle/);
    expect(a.text).toMatch(/New York short strangle \(22:30 IST\) \(gated\): skipped, gate WAIT \(DVOL 70\.0 >= 65\)/);
    expect(a.text).toMatch(/Calendar spread.*skipped, no backwardation: front IV 38\.0 vs back IV 45\.0/);
    expect(a.table!.rows).toHaveLength(1);
  });

  it('explains an empty day: bot off versus nothing due yet', async () => {
    const off = await answer('why no trade today', ctx(live({ botEnabled: () => false })));
    expect(off.text).toMatch(/switched off/);
    const on = await answer('why no trade today', ctx());
    expect(on.text).toMatch(/recorded no runs/);
    expect(on.text).toMatch(/ASIA_SHORT 10:00/);
  });
});

describe('ranking and exit quality', () => {
  it('needs enough trades, then ranks sessions, strategies and weekdays by average PnL', async () => {
    const few = await answer('which session is best?', ctx());
    expect(few.text).toMatch(/Only 0 closed live paper trades/);
    for (let i = 0; i < 6; i++) {
      await run({ strategy: 'NY_SHORT', date: `2026-10-0${i + 1}`, entry: istMs(`2026-10-0${i + 1}`, 22, 30), exit: istMs(`2026-10-0${i + 2}`, 7), net: 5, reason: 'tp' });
      await run({ strategy: 'ASIA_SHORT', date: `2026-10-0${i + 1}`, entry: istMs(`2026-10-0${i + 1}`, 10), exit: istMs(`2026-10-0${i + 1}`, 16), net: -3, reason: 'stop' });
    }
    const a = await answer('which session is best?', ctx());
    expect(a.intent).toBe('ranking');
    expect(a.text).toMatch(/Best session by average PnL per trade: New York \(\$5\.00\); worst: Asia \(-\$3\.00\)/);
    expect(a.table!.rows.length).toBeGreaterThan(4);
  });

  it('ranking uses only live trades: too few says so, enough names the session and the top performer with its reason', async () => {
    expect((await answer('which session is best?', ctx())).text).toMatch(/too few to rank/);
    for (let i = 0; i < 6; i++) await run({ strategy: 'NY_SHORT', date: '2026-10-2' + (i % 8), entry: istMs('2026-10-15', 22, 30) + i * 86_400_000, exit: istMs('2026-10-16', 7) + i * 86_400_000, net: 2, reason: 'time' });
    for (let i = 0; i < 6; i++) await run({ strategy: 'ASIA_SHORT', date: '2026-10-2' + (i % 8), entry: istMs('2026-10-15', 10) + i * 86_400_000, exit: istMs('2026-10-15', 16) + i * 86_400_000, net: -3, reason: 'stop' });
    const r = await answer('which session is best?', ctx());
    expect(r.text).toMatch(/Best session by average PnL per trade: New York/);
    expect(r.text).toMatch(/Top performer \(live paper\)/);
    expect(r.text).not.toMatch(/[Rr]eplay/);
  });

  it('live exit quality reports peak versus final and the give-back', async () => {
    await run({ strategy: 'ASIA_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 10), exit: istMs('2026-10-27', 16), net: 1, peak: 7, reason: 'time' });
    const a = await answer('how much did it give back from the peak', ctx());
    expect(a.table!.rows[0]).toEqual(['Asia short strangle (10:00 IST)', 1, '$1.00', '$7.00', '$6.00']);
  });
});

describe('positions, market, events and desk records', () => {
  it('positions: says the bot is off, none running, or lists them with distances', async () => {
    expect((await answer('running positions', ctx(live({ botEnabled: () => false })))).text).toMatch(/switched off/);
    expect((await answer('running positions', ctx())).text).toMatch(/No running positions/);
    const a = await answer('how is the NY short doing', ctx(live({
      positions: async () => [
        { strategy: 'NY_SHORT', book: 'always', marginUsd: 80, pnl: { netPnl: 4.2, pctOfMargin: 0.0525 }, exit: { tpPctOfMargin: 0.1 }, minutesToTimeExit: 300, spot: 80_800 },
        { strategy: 'ASIA_SHORT', book: 'always', marginUsd: 80, pnl: { netPnl: 1, pctOfMargin: 0.0125 }, exit: {}, spot: 80_800 },
      ],
    })));
    expect(a.intent).toBe('positions');
    expect(a.table!.rows).toHaveLength(1);
    expect(a.table!.rows[0]![3]).toBe('TP needs $3.80 more');
    const fut = await answer('futures positions', ctx(live({ positions: async () => [{ strategy: 'FUT_SWEEP_LDN', book: 'always', marginUsd: 40, spot: 80_000, pnl: { netPnl: -1, pctOfMargin: -0.025 }, exit: { kind: 'futures', target: 79_600, stop: 80_200 }, minutesToTimeExit: 600 }] })));
    expect(fut.table!.rows[0]![3]).toBe('target $400 away, stop $200 away');
  });

  it('market: live spot, DVOL versus the gate limit, macro stress and the last stored snapshot', async () => {
    await pool.query(`INSERT INTO indicator_snapshots (recorded_at, atm_iv, n2n_iv, term_current_n2n, term_next_n2n) VALUES (now(), 36.5, 38.2, -1.7, -0.4)`);
    const a = await answer('market now', ctx());
    expect(a.intent).toBe('market');
    expect(a.text).toMatch(/spot 80800/);
    expect(a.text).toMatch(/DVOL 38\.1 \(below the 65 gate limit\)/);
    expect(a.text).toMatch(/stress 22\/100, zone calm/);
    expect(a.text).toMatch(/ATM IV 36\.5, N2N IV 38\.2/);
    expect(a.sources).toContain('indicator_snapshots');
  });

  it('a question about backtests says the page only records live trades', async () => {
    const a = await answer('replay summary', ctx());
    expect(a.intent).toBe('replay');
    expect(a.text).toMatch(/only the trades the paper bot actually took live/);
  });

  it('events show recent warnings and errors, and the engine state', async () => {
    await pool.query(`INSERT INTO bot_events (type, severity, message) VALUES ('tick_error','error','options: chain fetch failed'), ('entry','info','x')`);
    const a = await answer('recent errors', ctx());
    expect(a.intent).toBe('events');
    expect(a.table!.rows).toHaveLength(1);
    expect(a.table!.rows[0]![3]).toMatch(/chain fetch failed/);
  });

  it('manual trades, nightly reviews, audits, recalibration and alerts read their own tables', async () => {
    await pool.query(`INSERT INTO trades (strategy, status, entry_time, exit_time, call_strike, put_strike, realized_pnl, exit_reason) VALUES ('SHORT_STRANGLE','CLOSED', to_timestamp(${NOW / 1000.0}) - interval '2 days', to_timestamp(${NOW / 1000.0}) - interval '1 day', 82500, 78500, 12, 'TAKE_PROFIT'), ('SHORT_STRANGLE','CLOSED', to_timestamp(${NOW / 1000.0}) - interval '3 days', to_timestamp(${NOW / 1000.0}) - interval '2 days', 82000, 78000, -20, 'STOP_LOSS')`);
    const t = await answer('my manual trades', ctx());
    expect(t.text).toMatch(/2 logged trades.*Realised -\$8\.00, win rate 50%/);
    await pool.query(`INSERT INTO nightly_reviews (session_date, verdict, outcome, iv_1730, notes) VALUES ('2026-10-27','SELL_FULL','PROFIT', 41.2, 'clean fall')`);
    expect((await answer('latest nightly review', ctx())).table!.rows[0]![1]).toBe('SELL_FULL');
    await pool.query(`INSERT INTO session_audit_logs (session_date, day_name, session_status, outcome, telemetry_match) VALUES ('2026-10-27','Tue','TRADED','WIN', true), ('2026-10-26','Mon','SKIPPED','SKIPPED', false)`);
    expect((await answer('telemetry audit', ctx())).text).toMatch(/2 audited sessions.*disagreed.*1 of them/);
    await pool.query(`INSERT INTO recalibration_audits (run_at, total_sessions, in_sample_sessions, out_of_sample_sessions, cleared_bonferroni, oos_stability_verdict, combo_stop_rate, oos_stop_rate, combo_p_value) VALUES (now(), 269, 134, 135, true, 'STABLE', 21.5, 22.1, 0.0123)`);
    expect((await answer('recalibration status', ctx())).text).toMatch(/269 sessions.*cleared.*Verdict: STABLE/);
    await pool.query(`INSERT INTO alert_logs (delivered_at, channel, status, title, message) VALUES (now(), 'telegram', 'SENT', 'Stop hit', 'NY short stopped')`);
    expect((await answer('last alerts', ctx())).table!.rows[0]).toEqual([expect.any(String), 'telegram', 'SENT', 'Stop hit', 'NY short stopped']);
  });

  it('a missing table gives a plain message instead of an error', async () => {
    await pool.query('DROP TABLE alert_logs');
    const a = await answer('last alerts', ctx());
    expect(a.text).toMatch(/alert_logs.*does not exist/);
    await pool.query('CREATE TABLE alert_logs (id serial, delivered_at timestamptz, channel text, status text, title text, message text)');
  });
});


describe('concepts from the terminal glossary and docs', () => {
  it('explains a terminal concept in plain words and names its source', async () => {
    const a = await answer('what is risk adx?', ctx());
    expect(a.intent).toBe('concept');
    expect(a.text).toMatch(/0-100 stop-risk line/);
    expect(a.text).toMatch(/green at or below 25/);
    expect(a.sources).toEqual(['terminal glossary']);
  });

  it('adds the live number for terms that have one', async () => {
    const a = await answer('what is dvol', ctx());
    expect(a.text).toMatch(/Deribit/);
    expect(a.text).toMatch(/Right now DVOL is 38\.1 \(below the 65 gate limit\)/);
    const f = await answer('explain funding rate', ctx());
    expect(f.text).toMatch(/Right now the BTC perpetual funding rate is 0\.0100%/);
  });

  it('answers a bare term, a comparison and a "how does it work" question', async () => {
    expect((await answer('n2n', ctx())).text).toMatch(/next-to-next/);
    expect((await answer('difference between contango and backwardation', ctx())).text).toMatch(/Backwardation means the near expiry is richer/);
    expect((await answer('how does the entry gauge turn green', ctx())).text).toMatch(/two hours under 30/);
  });

  it('falls back to text from the project docs, citing the document', async () => {
    const a = await answer('tell me about the zebra protocol', ctx());
    expect(a.text).toMatch(/striped gateway every Tuesday/);
    expect(a.sources).toEqual(['doc: TEST.md']);
  });

  it('a concept-shaped question about a live number is answered as a market question', async () => {
    const a = await answer('what is the price of btc', ctx());
    expect(a.intent).toBe('market');
    expect(a.text).toMatch(/spot 80800/);
  });

  it('says it does not know a term it has nothing on, and never invents one', async () => {
    const a = await answer('what is flurbo glorp', ctx());
    expect(a.intent).toBe('unknown');
    expect(a.text).toMatch(/could not match/);
    expect(a.text).toMatch(/what data do you have/);
  });

  it('rule and timing questions are explained from the glossary, not mistaken for data lookups', async () => {
    const thu = await answer('why is thursday skipped', ctx());
    expect(thu.intent).toBe('concept');
    expect(thu.text).toMatch(/Sunday 3-day expiry shock/);
    const fri = await answer('when is the best time to enter on friday', ctx());
    expect(fri.intent).toBe('concept');
    expect(fri.text).toMatch(/later \(about 23:00 IST\)/);
    const trap = await answer('what is the 17:30 settlement trap', ctx());
    expect(trap.intent).not.toBe('at_time');
    expect(trap.text).toMatch(/17:30 IST/);
    expect(trap.text).toMatch(/settlement trap/);
    const crush = await answer('what does iv crush mean', ctx());
    expect(crush.text).toMatch(/178 crush/);
  });

  it('does not answer from a glossary entry that merely shares one word with the question', async () => {
    for (const q of ['what is the weather today', 'who won the football match', 'how do i add a new strategy']) {
      const a = await answer(q, ctx());
      expect(a.intent, q).toBe('unknown');
    }
  });

  it('never answers a forecast from the glossary', async () => {
    for (const q of ['what will the price be next week', 'will thursday be a good day tomorrow', 'should i buy now']) {
      const a = await answer(q, ctx());
      expect(a.intent, q).toBe('unknown');
      expect(a.text, q).toMatch(/do not predict/);
    }
  });

  it('works with no knowledge provider at all', async () => {
    const a = await answer('what is n2n', { ...ctx(), knowledge: undefined });
    expect(a.intent).toBe('unknown');
  });
});

describe('exploring the database', () => {
  it('lists every readable table with counts and date ranges, and hides accounts and credentials', async () => {
    await run({ strategy: 'NY_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 22, 30), exit: istMs('2026-10-28', 7), net: 8.3, reason: 'tp' });
    await pool.query("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'HASH')");
    const a = await answer('what data do you have?', ctx());
    expect(a.intent).toBe('data_overview');
    expect(a.text).toMatch(/readable tables/);
    expect(a.text).toMatch(/browser.s own storage/);
    const names = a.table!.rows.map((r) => r[0]);
    expect(names).toEqual(expect.arrayContaining(['bot_runs', 'bot_events', 'alert_logs', 'trades', 'nightly_reviews']));
    expect(names).not.toContain('users');
    expect(names).not.toContain('api_credentials');
    const runs = a.table!.rows.find((r) => r[0] === 'bot_runs')!;
    expect(runs[1]).toBe(1);
    expect(String(runs[2])).toMatch(/2026-10-27/);
    expect(JSON.stringify(a)).not.toMatch(/HASH|a@b\.c/);
  });

  it('profiles a table: row count, time range, numbers, common values and the latest rows', async () => {
    await run({ strategy: 'NY_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 22, 30), exit: istMs('2026-10-28', 7), net: 8.3, reason: 'tp' });
    await run({ strategy: 'NY_SHORT', date: '2026-10-26', entry: istMs('2026-10-26', 22, 30), exit: istMs('2026-10-27', 7), net: -12.7, reason: 'stop' });
    await run({ strategy: 'ASIA_SHORT', date: '2026-10-26', entry: istMs('2026-10-26', 10), exit: istMs('2026-10-26', 16), net: 3, reason: 'time' });
    const a = await answer('summarise bot runs', ctx());
    expect(a.intent).toBe('table_summary');
    expect(a.sources).toEqual(['bot_runs']);
    expect(a.text).toMatch(/every paper trade the bot took or skipped/);
    expect(a.text).toMatch(/3 rows\./);
    expect(a.text).toMatch(/entry_at runs from .*2026-10-26.* to .*2026-10-27/);
    expect(a.text).toMatch(/strategy: NY_SHORT \(2\), ASIA_SHORT \(1\)/);
    expect(a.text).toMatch(/exit_reason: .*stop \(1\)/);
    const flat = JSON.stringify(a.table);
    expect(flat).toMatch(/net_pnl/);
    expect(flat).toMatch(/Latest 3 rows/);
    // net_pnl: average (8.3 - 12.7 + 3) / 3 = -0.467
    const net = a.table!.rows.find((r) => r[0] === 'net_pnl')!;
    expect(net[2]).toBe('-0.467');
    expect(net[3]).toBe('-12.7');
    expect(net[4]).toBe('8.3');
    expect(net[5]).toBe('-1.4');
  });

  it('respects a period, and says so when it is empty', async () => {
    await run({ strategy: 'NY_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 22, 30), exit: istMs('2026-10-28', 7), net: 8.3, reason: 'tp' });
    await run({ strategy: 'NY_SHORT', date: '2026-09-01', entry: istMs('2026-09-01', 22, 30), exit: istMs('2026-09-02', 7), net: 1, reason: 'tp' });
    const week = await answer('summary of bot runs last 3 days', ctx());
    expect(week.text).toMatch(/1 rows in last 3 days \(2 in total\)/);
    const none = await answer('summarise alert logs yesterday', ctx());
    expect(none.text).toMatch(/0 rows in yesterday/);
    expect(none.text).toMatch(/nothing in it/i);
  });

  it('never shows secret-looking columns, and says how many it hid', async () => {
    await pool.query("INSERT INTO secret_test (name, api_token, password_hash) VALUES ('visible-name', 'TOPSECRETTOKEN', 'TOPSECRETHASH')");
    const a = await answer('describe secret_test', ctx());
    // not a table the parser knows by name: it is recognised through the database catalog
    expect(a.intent).toBe('table_summary');
    expect(a.sources).toEqual(['secret_test']);
    expect(JSON.stringify(a)).toMatch(/visible-name/);
    expect(JSON.stringify(a)).not.toMatch(/TOPSECRET|api_token|password_hash/);
    expect(a.text).toMatch(/Columns: id, name, created_at \(2 hidden for safety\)/);
  });

  it('refuses to open accounts and credentials', async () => {
    await pool.query("INSERT INTO users (email, password_hash) VALUES ('a@b.c', 'HASH')");
    for (const q of ['summarise users', 'describe the users table', 'show me the api_credentials table', 'summarise api keys']) {
      const a = await answer(q, ctx());
      expect(JSON.stringify(a), q).not.toMatch(/HASH|a@b\.c|api_secret/);
      expect(a.text, q).toMatch(/never show|could not find|do not open/i);
    }
  });

  it('cannot be used to run SQL: table names only ever come from the catalog', async () => {
    await run({ strategy: 'NY_SHORT', date: '2026-10-27', entry: istMs('2026-10-27', 22, 30), exit: istMs('2026-10-28', 7), net: 1, reason: 'tp' });
    const a = await answer('summarise bot runs; DROP TABLE bot_runs; --', ctx());
    expect(a.intent).toBe('table_summary');
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM bot_runs')).rows[0].n).toBe(1);
    const b = await answer('summarise "bot_runs\"; DROP TABLE bot_events;--"', ctx());
    expect(b.text).toBeTruthy();
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM bot_events')).rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('a table that does not exist gives a plain message that lists what does', async () => {
    const a = await answer('summarise chart drawings', ctx());
    expect(a.text).toMatch(/could not find a table matching "chart_drawings"/);
    expect(a.text).toMatch(/bot_runs/);
  });

  it('works on the other desk tables too (alert logs and nightly reviews)', async () => {
    await pool.query(`INSERT INTO alert_logs (delivered_at, channel, status, title, message) VALUES (now(), 'telegram', 'SENT', 'Stop hit', 'x'), (now(), 'ntfy', 'FAILED', 'Entry', 'y'), (now(), 'telegram', 'SENT', 'Exit', 'z')`);
    const a = await answer('how many rows in alert logs', ctx());
    expect(a.text).toMatch(/3 rows\./);
    expect(a.text).toMatch(/channel: telegram \(2\), ntfy \(1\)/);
    expect(a.text).toMatch(/status: SENT \(2\), FAILED \(1\)/);
  });
});
