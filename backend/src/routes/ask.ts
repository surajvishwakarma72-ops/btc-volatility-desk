import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SUGGESTIONS } from '../lib/ask/parse.js';
import { pool } from '../db/index.js';
import { GLOSSARY } from '../lib/ask/glossary.js';
import { DOCS_INDEX } from '../lib/ask/docs-index.generated.js';
import { answer, type AskContext } from '../services/ask/answer.js';
import { botEngine } from '../services/bot/bot-engine.js';
import { ensureBotSchema } from '../services/bot/bot-store.js';
import { loadReplay } from '../services/bot/replay-file.js';
import { deribitWorker } from '../services/deribit-flow-worker.js';
import { deltaWorker } from '../services/delta-market-worker.js';
import { macroStressWorker } from '../services/macro-stress-worker.js';

/** The user's taught notes live in one small table, created on first use. */
let notesReady: Promise<void> | null = null;
const ensureNotes = () => {
  if (!notesReady) {
    notesReady = pool
      .query('CREATE TABLE IF NOT EXISTS ask_notes (id serial PRIMARY KEY, q text NOT NULL, a text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())')
      .then(() => undefined);
    notesReady.catch(() => { notesReady = null; });
  }
  return notesReady;
};
const mapNote = (r: any) => ({ id: Number(r.id), q: String(r.q), a: String(r.a), at: new Date(r.created_at).getTime() });
export const notesStore = {
  async all() {
    await ensureNotes();
    return (await pool.query('SELECT id, q, a, created_at FROM ask_notes ORDER BY id')).rows.map(mapNote);
  },
  async add(q: string, a: string) {
    await ensureNotes();
    return mapNote((await pool.query('INSERT INTO ask_notes (q, a) VALUES ($1, $2) RETURNING id, q, a, created_at', [q, a])).rows[0]);
  },
  async remove(id: number) {
    await ensureNotes();
    return ((await pool.query('DELETE FROM ask_notes WHERE id = $1', [id])).rowCount ?? 0) > 0;
  },
};

export function buildContext(): AskContext {
  return {
    now: Date.now(),
    notes: notesStore,
    // compiled into the server (see scripts/build-knowledge.ts); never read from the public web folder
    knowledge: () => [...GLOSSARY, ...DOCS_INDEX],
    q: async (sql, params) => (await pool.query(sql, params as never)).rows,
    live: {
      botEnabled: () => botEngine.enabled,
      botStatus: () => ({ engine: botEngine.status, mode: process.env.BOT_MODE ?? 'paper', lastTickAt: botEngine.lastTickAt || null, lastError: botEngine.lastError }),
      positions: () => botEngine.livePositions(),
      waiting: () => (botEngine.enabled ? botEngine.waitingEntries() : []),
      market: () => {
        const m = macroStressWorker.getSnapshot();
        return {
          spot: deltaWorker.currentSpotPrice ?? null,
          mark: deltaWorker.currentMarkPrice ?? null,
          funding: deltaWorker.currentFundingRate ?? null,
          oi: deltaWorker.currentOi ?? null,
          dvol: deribitWorker.currentDvol ?? null,
          macro: m ? { score: m.score, zone: m.zone, direction: m.direction, nextEvent: m.nextEvent, tradeRule: m.tradeRule } : null,
        };
      },
      replay: loadReplay,
    },
  };
}

/**
 * The desk's own question-answering endpoint. Rule-based and read-only: it parses the question,
 * reads the database / live state / replay results, and returns an answer with its sources.
 * It never calls an outside service and cannot change anything.
 */
export const askRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };

  fastify.get('/suggestions', auth, async () => ({ success: true, suggestions: SUGGESTIONS }));

  fastify.post('/', { ...auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ question: z.string().trim().min(1).max(300) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ success: false, error: 'Send { "question": "..." } (1 to 300 characters).' });
    try {
      await ensureBotSchema();
    } catch { /* answers about other tables can still work */ }
    const a = await answer(body.data.question, buildContext());
    return { success: true, ...a };
  });
};
