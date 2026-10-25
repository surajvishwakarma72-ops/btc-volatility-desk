import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SUGGESTIONS } from '../lib/ask/parse.js';
import { pool } from '../db/index.js';
import { GLOSSARY } from '../lib/ask/glossary.js';
import { DOCS_INDEX } from '../lib/ask/docs-index.generated.js';
import { answer, type AskContext } from '../services/ask/answer.js';
import { botEngine } from '../services/bot/bot-engine.js';
import { ensureBotSchema } from '../services/bot/bot-store.js';
import { deribitWorker } from '../services/deribit-flow-worker.js';
import { deltaWorker } from '../services/delta-market-worker.js';
import { macroStressWorker } from '../services/macro-stress-worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let replayCache: { at: number; data: any | null } | null = null;
function loadReplay(): any | null {
  if (replayCache && Date.now() - replayCache.at < 10 * 60_000) return replayCache.data;
  const candidates = [
    path.resolve(here, '../../../frontend/dist/data/bot_replay.json'),
    path.resolve(here, '../../../frontend/public/data/bot_replay.json'),
    path.resolve(process.cwd(), 'frontend/dist/data/bot_replay.json'),
    path.resolve(process.cwd(), '../frontend/dist/data/bot_replay.json'),
  ];
  let data: any | null = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, 'utf8'));
        break;
      }
    } catch { /* try the next location */ }
  }
  replayCache = { at: Date.now(), data };
  return data;
}

export function buildContext(): AskContext {
  return {
    now: Date.now(),
    // compiled into the server (see scripts/build-knowledge.ts); never read from the public web folder
    knowledge: () => [...GLOSSARY, ...DOCS_INDEX],
    q: async (sql, params) => (await pool.query(sql, params as never)).rows,
    live: {
      botEnabled: () => botEngine.enabled,
      botStatus: () => ({ engine: botEngine.status, mode: process.env.BOT_MODE ?? 'paper', lastTickAt: botEngine.lastTickAt || null, lastError: botEngine.lastError }),
      positions: () => botEngine.livePositions(),
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
