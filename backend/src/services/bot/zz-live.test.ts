import { describe, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
const h = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../db/index.js', () => ({ pool: { query: async (t: string, p?: unknown[]) => { if (!p || !p.length) { const r = await h.db.exec(t); const l = r[r.length - 1]; return { rows: l?.rows ?? [], rowCount: l?.rows?.length ?? 0 }; } const r = await h.db.query(t, p); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }; } } }));
vi.mock('./gate.js', () => ({ evaluateGate: () => ({ version: 'v1', go: true, reasons: [], dvol: 40, macroZone: 'calm', macroScore: 10, nextEvent: 'No Tier-1', eventInWindow: false }) }));
const { BotEngine } = await import('./bot-engine.js');
const store = await import('./bot-store.js');
const { pool } = await import('../../db/index.js');
describe('bot on live Delta data', () => {
  it('enters its strategies against the real chain and books', async () => {
    h.db = new PGlite();
    process.env.BOT_ENABLED = 'true'; process.env.BOT_FUTURES = 'false';
    await store.ensureBotSchema();
    const e = new BotEngine();
    (e as any).status = 'running';
    const day = new Date().toISOString().slice(0, 10);
    // 10:00 IST today = 04:30Z
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(day + 'T04:31:00Z'));
    await e.tick();
    const runs = (await pool.query('SELECT strategy, book, status, margin_usd, tags FROM bot_runs ORDER BY strategy, book')).rows;
    console.log('runs', JSON.stringify(runs.map((r: any) => ({ s: r.strategy, b: r.book, st: r.status, m: r.margin_usd, why: r.tags?.reason }))));
    const legs = (await pool.query('SELECT r.strategy, l.symbol, l.side, l.entry_price FROM bot_legs l JOIN bot_runs r ON r.id=l.run_id ORDER BY l.id')).rows;
    console.log('legs', JSON.stringify(legs));
    console.log('waiting', JSON.stringify(e.waitingEntries()));
    console.log('events', JSON.stringify((await pool.query("SELECT type, message FROM bot_events ORDER BY id")).rows));
    console.log('lastError', e.lastError);
  }, 90000);
});
