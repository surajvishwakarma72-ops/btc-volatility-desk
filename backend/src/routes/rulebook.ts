import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../lib/authenticate.js';
import { RULEBOOK } from '../lib/rulebook/content.js';
import {
  addJournal, EXIT_REASONS, getState, journal, liveChecklist, logRuleBreak, recentBreaks, review, setEquity, unlockToday,
} from '../services/rulebook/rulebook-service.js';
import { userId } from '../lib/guards.js';
import { tonight } from '../lib/calendar/tonight.js';
import { loadUsEvents } from '../services/algo/event-guard.js';
import { topTierReleases } from '../lib/rulebook/checklist.js';
import { calendarReleases } from '../services/rulebook/rulebook-service.js';
import { volRead } from '../services/vol/vol-history.js';

/** The typed sentence that unlocks a reached daily stop. */
export const UNLOCK_PHRASE = 'I accept the risk';

const uidOf = (req: any): string => userId(req);

/** /api/v1/rulebook: the rules, the live before-entry checklist, and the user's own rule breaks and journal. */
export const rulebookRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: authenticate };

  fastify.get('/content', async () => ({ success: true, ...RULEBOOK, exitReasons: EXIT_REASONS }));

  // Tonight's entry window, sessions in IST, week ratings and calendar size. Market information only, so no login needed.
  fastify.get('/tonight', async () => {
    const now = Date.now();
    const ev = await loadUsEvents(now).catch(() => null);
    const vol = await volRead(now).catch(() => null);
    return { success: true, calendarLive: !!ev, ...tonight(now, calendarReleases(ev ? topTierReleases(ev) : null, now)), vol };
  });

  fastify.get('/checklist', auth, async (req) => ({ success: true, ...(await liveChecklist(uidOf(req))) }));

  fastify.get('/state', auth, async (req) => {
    const uid = uidOf(req);
    return { success: true, state: await getState(uid), breaks: await recentBreaks(uid, 20), review: await review(uid, 7) };
  });

  fastify.post('/equity', auth, async (req, reply) => {
    const b = z.object({ equityUsd: z.number().positive().max(1e9) }).safeParse(req.body);
    if (!b.success) return reply.status(400).send({ success: false, error: 'equityUsd must be a positive number' });
    return { success: true, state: await setEquity(uidOf(req), b.data.equityUsd) };
  });

  fastify.post('/unlock', auth, async (req, reply) => {
    const b = z.object({ confirm: z.string() }).safeParse(req.body);
    if (!b.success || b.data.confirm.trim() !== UNLOCK_PHRASE) return reply.status(400).send({ success: false, error: `Type exactly: ${UNLOCK_PHRASE}` });
    return { success: true, state: await unlockToday(uidOf(req)) };
  });

  fastify.post('/break', auth, async (req, reply) => {
    const b = z.object({ rules: z.array(z.string().max(120)).max(20), note: z.string().max(500).optional() }).safeParse(req.body);
    if (!b.success) return reply.status(400).send({ success: false, error: 'rules must be a list of rule names' });
    await logRuleBreak(uidOf(req), b.data.rules, b.data.note ?? null);
    return { success: true, state: await getState(uidOf(req)) };
  });

  const journalSchema = z.object({
    expiry: z.string().max(20).optional(),
    callDelta: z.number().nullable().optional(),
    putDelta: z.number().nullable().optional(),
    lots: z.number().nullable().optional(),
    riskPct: z.number().nullable().optional(),
    exitAt: z.number().nullable().optional(),
    exitReason: z.enum(EXIT_REASONS),
    netPnlUsd: z.number(),
    peakUsd: z.number().nullable().optional(),
    maxDrawdownUsd: z.number().nullable().optional(),
    rulesBroken: z.string().max(500).optional(),
    lesson: z.string().max(300).optional(),
  });

  fastify.post('/journal', auth, async (req, reply) => {
    const b = journalSchema.safeParse(req.body);
    if (!b.success) return reply.status(400).send({ success: false, error: b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const uid = uidOf(req);
    // the gate readings at the time of logging, so the journal shows what the rules said
    const c = await liveChecklist(uid).catch(() => null);
    const gates = c ? Object.fromEntries(c.items.map((x) => [x.label, `${x.ok === true ? '✓' : '✗'} ${x.now}`])) : undefined;
    return { success: true, ...(await addJournal(uid, { ...b.data, gates })) };
  });

  fastify.get('/journal', auth, async (req) => {
    const days = Math.min(Math.max(Number((req.query as { days?: string }).days) || 30, 1), 730);
    return { success: true, entries: await journal(uidOf(req), Date.now() - days * 86_400_000) };
  });
};
