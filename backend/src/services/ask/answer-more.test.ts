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
const { ensurePaperSchema } = await import('../paper/paper-terminal.js');
const { notesStore } = await import('../../routes/ask.js');
const { pool } = await import('../../db/index.js');

const NOW = Date.parse('2026-10-28T06:30:00Z');
const live = (over: Record<string, unknown> = {}) => ({
  botEnabled: () => true,
  botStatus: () => ({ engine: 'running', mode: 'paper', lastTickAt: NOW, lastError: null }),
  positions: async () => [] as any[],
  market: () => ({ spot: 80_800.4, mark: 80_810, funding: 0.0001, oi: 123_456, dvol: 38.1, macro: null }),
  replay: () => null as any,
  ...over,
});
const ctx = (l = live()) => ({ q: async (sql: string, params?: unknown[]) => (await pool.query(sql, params as never)).rows, now: NOW, live: l, knowledge: () => [...GLOSSARY], notes: notesStore });

beforeAll(async () => {
  h.db = new PGlite() as never;
  await ensureBotSchema();
  await ensurePaperSchema();
});
beforeEach(async () => {
  await pool.query('DELETE FROM bot_runs; DELETE FROM bot_params; DELETE FROM bot_learning; DELETE FROM paper_fills; DELETE FROM paper_orders; DELETE FROM paper_positions; DELETE FROM paper_account;');
  await notesStore.all();
  await pool.query('DELETE FROM ask_notes');
});

describe('teach me', () => {
  it('stores a note, answers that question from it, and a close wording too', async () => {
    const t = await answer('teach: what is my Friday plan => Full size at 23:00 IST, never skip.', ctx());
    expect(t.intent).toBe('teach');
    expect(t.text).toMatch(/Saved as note #\d+/);
    const exact = await answer('what is my Friday plan', ctx());
    expect(exact.text).toMatch(/From your own note #\d+/);
    expect(exact.text).toMatch(/Full size at 23:00 IST/);
    expect(exact.sources).toEqual(['your notes']);
    const close = await answer('tell me my friday plan', ctx());
    expect(close.text).toMatch(/Full size at 23:00/);
  });

  it('replaces a note with the same question instead of duplicating it', async () => {
    await answer('remember: my risk limit => $300 a day', ctx());
    const u = await answer('teach: my risk limit => $250 a day', ctx());
    expect(u.text).toMatch(/Updated/);
    const list = await answer('what have I taught you', ctx());
    expect(list.table!.rows).toHaveLength(1);
    expect(String(list.table!.rows[0]![2])).toMatch(/\$250/);
  });

  it('forgets a note by number, and says so when there is none', async () => {
    const t = await answer('teach: favourite strike => the 80k put', ctx());
    const id = /#(\d+)/.exec(t.text)![1]!;
    expect((await answer(`forget note ${id}`, ctx())).text).toMatch(/Forgot note/);
    expect((await answer(`forget note ${id}`, ctx())).text).toMatch(/no note/);
    expect((await answer('what have I taught you', ctx())).text).toMatch(/not taught me anything/);
  });

  it('refuses to store anything that looks like an address, login or key', async () => {
    for (const s of ['teach: my server => ssh ubuntu@203.0.113.9', 'teach: api => api_key = abcdef1234567890abcd', 'teach: db => postgres://user:pw@host/db']) {
      const r = await answer(s, ctx());
      expect(r.text, s).toMatch(/did not save/);
    }
    expect(await notesStore.all()).toHaveLength(0);
  });

  it('a note never stands in for live data', async () => {
    await answer('teach: how is the NY short doing => it is perfect', ctx());
    const a = await answer('how is the NY short doing', ctx());
    expect(a.intent).toBe('positions');
    expect(a.text).not.toMatch(/perfect/);
  });

  it('rejects a malformed teach request with the format', async () => {
    const r = await answer('teach: x => y', ctx());
    expect(r.text).toMatch(/3 to 200 characters/);
  });
});

describe('auto-learn and paper account answers', () => {
  it('says plainly that no review has run yet', async () => {
    const a = await answer('what has auto-learn changed?', ctx());
    expect(a.intent).toBe('learning');
    expect(a.text).toMatch(/starting rules/);
    expect(a.text).toMatch(/No review has run yet/);
  });

  it('reports the champion, last review and promotions from the log', async () => {
    await pool.query(`INSERT INTO bot_params (strategy, params) VALUES ('ASIA_SHORT', '{"dvolMax":65,"stopMultiple":3,"tpPct":0.1}')`);
    await pool.query(`INSERT INTO bot_learning (strategy, kind, reason) VALUES ('ASIA_SHORT','promotion','ASIA_SHORT: stopMultiple 2 -> 3. Over 45 days it earned more.')`);
    await pool.query(`INSERT INTO bot_learning (strategy, kind, reason) VALUES ('ASIA_SHORT','evaluation','Champion kept.')`);
    const a = await answer('did the bot learn anything, any promotion?', ctx());
    expect(a.intent).toBe('learning');
    expect(a.text).toMatch(/stop at 3x the sold price/);
    expect(a.text).toMatch(/changed by auto-learn/);
    expect(a.text).toMatch(/Champion kept/);
    expect(a.text).toMatch(/PROMOTION: ASIA_SHORT: stopMultiple 2 -> 3/);
  });

  it('a definition of auto-learn comes from the glossary, not the log', async () => {
    const a = await answer('what is auto-learn', ctx());
    expect(a.intent).toBe('concept');
    expect(a.text).toMatch(/champion/i);
    expect(a.text).toMatch(/30 days/);
  });

  it('reads the paper account from its own tables', async () => {
    expect((await answer('my paper account', ctx())).text).toMatch(/has not been opened yet/);
    await pool.query(`INSERT INTO paper_account (id, cash, start_balance, realized_total, fees_total) VALUES (1, 10120.5, 10000, 130, 9.5)`);
    await pool.query(`INSERT INTO paper_positions (symbol, kind, lots, avg_entry, leverage) VALUES ('BTCUSD','perp',100,80000,10)`);
    await pool.query(`INSERT INTO paper_orders (symbol, kind, side, otype, lots, price, status) VALUES ('BTCUSD','perp','sell','limit',100,82000,'working')`);
    const a = await answer('what are my paper positions', ctx());
    expect(a.intent).toBe('paper');
    expect(a.text).toMatch(/cash \$10120\.50/);
    expect(a.text).toMatch(/1 open position, 1 working order/);
    expect(a.table!.rows.map((r) => r[0])).toEqual(['position', 'working order']);
  });
});

describe('why the bot did not trade, with the wait window', () => {
  it('lists the attempts and every reason seen, and what is still waiting', async () => {
    await pool.query(
      `INSERT INTO bot_runs (run_key, strategy, book, mode, date_key, status, tags) VALUES ('ASIA_SHORT:2026-10-28:gated','ASIA_SHORT','gated','paper','2026-10-28','skipped', $1)`,
      [JSON.stringify({ reason: 'gate WAIT (DVOL 70 >= 65)', attempts: 120, reasonsSeen: [{ reason: 'gate WAIT (DVOL 70 >= 65)' }, { reason: 'risk guard blocked: daily loss' }] })],
    );
    const a = await answer('why no trade today', ctx(live({ waiting: () => [{ key: 'NY_SHORT:2026-10-28:gated', attempts: 7, lastReason: 'gate WAIT (macro zone stress)', windowEndMs: NOW + 90 * 60_000 }] })));
    expect(a.text).toMatch(/it kept trying through its wait window \(120 checks\)/);
    expect(a.text).toMatch(/reasons seen along the way: gate WAIT \(DVOL 70 >= 65\) \| risk guard blocked: daily loss/);
    expect(a.text).toMatch(/Still waiting: New York short strangle \(22:30 IST\) \(gated\) has checked 7 times and will keep trying for another 90 minutes/);
  });
});

describe('glossary coverage of the new features', () => {
  it.each([
    ['how long does the asia short strangle wait for a valid entry', 'glossary:waitwindow'],
    ['what is a bracket order', 'glossary:bracket'],
    ['what does reduce only mean', 'glossary:reduceonly'],
    ['what is a market order versus a limit order', 'glossary:ordertypes'],
    ['how is the paper account liquidated', 'glossary:paperliq'],
    ['what is a call option', 'glossary:callput'],
    ['what is theta', 'glossary:greeks'],
    ['what is the difference between maker and taker', 'glossary:makertaker'],
    ['what are the shadow marks', 'glossary:shadow'],
    ['what is the top performer banner', 'glossary:topperf'],
  ])('%s', async (q, id) => {
    const a = await answer(q, ctx());
    const entry = GLOSSARY.find((g) => g.id === id)!;
    expect(a.text.startsWith(entry.title), `${q} -> ${a.text.slice(0, 80)}`).toBe(true);
  });
});
