import type { WatchLeg } from '../../lib/watch/classify.js';
import { botEngine } from '../bot/bot-engine.js';
import { DESK_USER_ID } from '../auth-store.js';
import { loadDeltaKey, usersWithDeltaKey } from '../delta-keys.js';
import { activePaperIds, marketFeed, peekPaper } from '../paper/paper-terminal.js';
import { expiryOf, fetchOptionPositions, LiveExit, realLiveExitDeps, type OptionPosition } from './live-exit.js';
import { getWatchConfig } from './watch-store.js';
import { WatchService, type WatchSources } from './watch.js';

/** The real sources for the stop alarm: the paper bot, each user's paper strategies, and each user's real Delta positions. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const expiryLabel = (code: string): string => (/^\d{6}$/.test(code) ? `Delta · ${Number(code.slice(0, 2))} ${MON[Number(code.slice(2, 4)) - 1] ?? ''} expiry` : `Delta · ${code}`);

const ticks = new Map<string, number>();
const posCache = new Map<string, { at: number; list: OptionPosition[] }>();
let userCache: { at: number; ids: string[] } | null = null;

async function realCreds(userId: string): Promise<{ key: string; secret: string } | null> {
  const own = await loadDeltaKey(userId, 'read');
  if (own) return own;
  // the owner may still rely on the server's own key until a personal one is saved
  if (userId === DESK_USER_ID && process.env.DELTA_API_KEY && process.env.DELTA_API_SECRET) return { key: process.env.DELTA_API_KEY, secret: process.env.DELTA_API_SECRET };
  return null;
}

/**
 * The accounts to watch: the read key's account and, when the trading key belongs to a different account (a sub-account), that one too.
 * Legs from the read account are watch-only when the two differ: they get their own group (":watch") that the hard exit never acts on,
 * because the hard exit only ever sends orders with the trading key.
 */
async function watchedAccounts(userId: string): Promise<Array<{ creds: { key: string; secret: string }; watchOnly: boolean }>> {
  const read = await realCreds(userId);
  const trade = await loadDeltaKey(userId, 'trade');
  if (read && trade && read.key !== trade.key) return [{ creds: read, watchOnly: true }, { creds: trade, watchOnly: false }];
  const one = trade ?? read;
  return one ? [{ creds: one, watchOnly: false }] : [];
}

async function realLegs(userId: string, stopMultiple: number): Promise<WatchLeg[] | null> {
  const accounts = await watchedAccounts(userId);
  if (!accounts.length) return null;
  const lists: Array<{ list: OptionPosition[]; watchOnly: boolean }> = [];
  for (const a of accounts) {
    const ck = `${userId}|${a.creds.key}`;
    let hit = posCache.get(ck);
    if (!hit || Date.now() - hit.at > 8_000) {
      hit = { at: Date.now(), list: await fetchOptionPositions(a.creds.key, a.creds.secret) };
      posCache.set(ck, hit);
    }
    lists.push({ list: hit.list, watchOnly: a.watchOnly });
  }
  if (!lists.some((l) => l.list.length)) return [];
  const snap = await marketFeed().fast();
  const by = new Map(snap.rows.map((r) => [r.symbol, r]));
  for (const r of snap.rows) ticks.set(r.symbol, r.tick);
  const out: WatchLeg[] = [];
  for (const { list, watchOnly } of lists) {
    for (const p of list) {
      if (p.size >= 0) continue; // only sold legs have a stop to watch
      const row = by.get(p.symbol), mark = row && row.mark > 0 ? row.mark : null;
      const exp = expiryOf(p.symbol), label = expiryLabel(exp);
      out.push({ source: 'delta', group: watchOnly ? `${exp}:watch` : exp, groupLabel: watchOnly ? label.replace('Delta ·', 'Delta main (watch only) ·') : label, symbol: p.symbol, side: 'sold', entry: p.entry, mark, stop: p.entry * stopMultiple, lots: Math.abs(p.size) });
    }
  }
  return out;
}

const liveExit = new LiveExit(realLiveExitDeps((s) => ticks.get(s) ?? 0.5));

export const realSources: WatchSources = {
  async users() {
    if (!userCache || Date.now() - userCache.at > 60_000) {
      userCache = { at: Date.now(), ids: await usersWithDeltaKey().catch(() => userCache?.ids ?? []) };
    }
    return [...new Set([DESK_USER_ID, ...activePaperIds(), ...userCache.ids])];
  },
  isOwner: (id) => id === DESK_USER_ID,
  config: (id) => getWatchConfig(id),
  bot: () => (botEngine.enabled ? botEngine.watchLegs() : Promise.resolve([])),
  paper: async (id) => (await peekPaper(id)?.watchLegs()) ?? [],
  real: (id, cfg) => realLegs(id, cfg.stopMultiple),
  hardExit: async (id, group, cfg) => { await liveExit.run(id, group, { liveArmed: cfg.liveArmed, dryRun: cfg.dryRun }); },
};

export const watchService = new WatchService(realSources);
