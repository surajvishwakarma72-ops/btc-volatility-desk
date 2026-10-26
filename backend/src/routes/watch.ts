import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { masterKeyConfigured, MasterKeyMissing } from '../lib/crypto.js';
import { userId } from '../lib/guards.js';
import { deleteDeltaKey, deltaKeyStatus, hasDeltaKey, saveDeltaKey } from '../services/delta-keys.js';
import { getWatchConfig, recentWatchEvents, saveWatchConfig } from '../services/watch/watch-store.js';
import { watchService } from '../services/watch/sources.js';
import { deltaSignedGet } from './delta.js';

/**
 * The stop alarm's API.
 *  GET  /watch             what is being watched right now and which positions are in alarm (the screen polls this)
 *  GET/PUT /watch/settings points before the stop for the alarm and for the hard exit, the stop multiple for real positions
 *  PUT  /watch/live        arm the hard exit / turn dry-run off (each needs a typed confirmation)
 *  GET/PUT/DELETE /watch/trade-key   the separate trading key that only the hard exit uses
 *  GET  /watch/events      what the hard exit did or would have done
 */
export const watchRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: (fastify as any).authenticate };
  const liveSwitch = () => process.env.LIVE_TRADING_ENABLED === 'true';

  const state = async (uid: string) => {
    const [cfg, hasTrade] = await Promise.all([getWatchConfig(uid, 0), hasDeltaKey(uid, 'trade')]);
    return { watchReal: cfg.watchReal, liveArmed: cfg.liveArmed, dryRun: cfg.dryRun, hasTradeKey: hasTrade, serverLiveSwitch: liveSwitch(), settings: { warnPoints: cfg.warnPoints, hardPoints: cfg.hardPoints, stopMultiple: cfg.stopMultiple } };
  };

  fastify.get('/', auth, async (request) => {
    const uid = userId(request);
    const snap = watchService.snapshotFor(uid);
    const cfg = await getWatchConfig(uid);
    return {
      success: true, now: Date.now(),
      snapshot: snap ?? { at: null, settings: { warnPoints: cfg.warnPoints, hardPoints: cfg.hardPoints, stopMultiple: cfg.stopMultiple }, groups: [], alarms: [], problems: [] },
      live: { armed: cfg.liveArmed, dryRun: cfg.dryRun, serverSwitch: liveSwitch() },
    };
  });

  fastify.get('/settings', auth, async (request) => ({ success: true, ...(await state(userId(request))) }));

  fastify.put('/settings', auth, async (request, reply) => {
    const b = z.object({
      warnPoints: z.number().min(1).max(500).optional(), hardPoints: z.number().min(0).max(200).optional(), stopMultiple: z.number().min(1.1).max(10).optional(),
      watchReal: z.boolean().optional(), dryRun: z.boolean().optional(),
    }).safeParse(request.body ?? {});
    if (!b.success) return reply.status(400).send({ success: false, error: 'warnPoints 1-500, hardPoints 0-200, stopMultiple 1.1-10' });
    if (b.data.dryRun === false) return reply.status(400).send({ success: false, error: 'Turning dry-run off is done with PUT /watch/live and a typed confirmation' });
    const uid = userId(request);
    await saveWatchConfig(uid, b.data);
    return { success: true, ...(await state(uid)) };
  });

  // arming and going live each need the person to type a word, and going live needs everything else in place first
  fastify.put('/live', { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = z.object({ armed: z.boolean().optional(), dryRun: z.boolean().optional(), confirm: z.string().optional() }).safeParse(request.body ?? {});
    if (!b.success) return reply.status(400).send({ success: false, error: 'send { armed, dryRun, confirm }' });
    const uid = userId(request), cur = await getWatchConfig(uid, 0), hasTrade = await hasDeltaKey(uid, 'trade');
    const patch: { liveArmed?: boolean; dryRun?: boolean } = {};
    if (b.data.armed === true) {
      if (!hasTrade) return reply.status(400).send({ success: false, error: 'Save a trading key first.' });
      if (b.data.confirm !== 'ARM') return reply.status(400).send({ success: false, error: 'Type ARM to arm the hard exit.' });
      patch.liveArmed = true;
    }
    if (b.data.armed === false) { patch.liveArmed = false; patch.dryRun = true; } // disarming also puts it back in dry-run
    if (b.data.dryRun === true) patch.dryRun = true;
    if (b.data.dryRun === false) {
      if (!(patch.liveArmed ?? cur.liveArmed)) return reply.status(400).send({ success: false, error: 'Arm the hard exit first.' });
      if (!liveSwitch()) return reply.status(400).send({ success: false, error: 'The server owner has not enabled live trading (LIVE_TRADING_ENABLED). Dry-run stays on.' });
      if (b.data.confirm !== 'GO LIVE') return reply.status(400).send({ success: false, error: 'Type GO LIVE to let the hard exit send real orders.' });
      patch.dryRun = false;
    }
    await saveWatchConfig(uid, patch);
    return { success: true, ...(await state(uid)) };
  });

  fastify.get('/trade-key', auth, async (request) => ({ success: true, encryptionReady: masterKeyConfigured(), ...(await deltaKeyStatus(userId(request), 'trade')) }));

  fastify.put('/trade-key', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const b = z.object({ apiKey: z.string().trim().min(8).max(200), apiSecret: z.string().trim().min(8).max(400) }).safeParse(request.body);
    if (!b.success) return reply.status(400).send({ success: false, error: 'send apiKey and apiSecret' });
    if (!masterKeyConfigured()) return reply.status(503).send({ success: false, error: new MasterKeyMissing().message });
    const check = await deltaSignedGet(b.data.apiKey, b.data.apiSecret, '/v2/wallet/balances', '');
    if (!check.ok) {
      const code = (check.body as any)?.error?.code ?? (check.body as any)?.error ?? check.errorText;
      return reply.status(400).send({ success: false, error: `Delta did not accept this key (${String(code).slice(0, 120)}). Add this server's IP to its whitelist.` });
    }
    const uid = userId(request);
    await saveDeltaKey(uid, b.data.apiKey, b.data.apiSecret, 'trade');
    return { success: true, ...(await deltaKeyStatus(uid, 'trade')), note: 'Saved. Delta cannot confirm a key may trade without a real order, so the first dry-run is the check: arm it, leave dry-run on, and read the events.' };
  });

  fastify.delete('/trade-key', auth, async (request) => {
    const uid = userId(request);
    const removed = await deleteDeltaKey(uid, 'trade');
    await saveWatchConfig(uid, { liveArmed: false, dryRun: true }); // no key, so nothing can stay armed
    return { success: true, removed };
  });

  fastify.get('/events', auth, async (request) => ({ success: true, events: await recentWatchEvents(userId(request), 40) }));
};
