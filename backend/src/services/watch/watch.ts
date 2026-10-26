import { isAlarm, statusOf, worst, type Level, type LegStatus, type WatchLeg, type WatchSettings } from '../../lib/watch/classify.js';

/**
 * Keeps watching every open position for its stop. Every few seconds it takes the legs from each source (the paper bot, the user's paper
 * strategies, the user's real Delta positions), works out how many points each has left before its stop, and keeps one snapshot per user
 * for the screen to show. It runs on the server, so it watches with the screen off. Sources are injected, which keeps this testable.
 */
export interface AlarmLeg {
  symbol: string;
  side: 'sold' | 'bought';
  lots: number;
  entry: number;
  mark: number | null;
  stop: number;
  pointsLeft: number | null;
  level: Level;
}

export interface WatchGroup {
  id: string;
  source: WatchLeg['source'];
  label: string;
  level: Level;
  /** When this group's alarm started (ms), null while it is safe. */
  since: number | null;
  legs: AlarmLeg[];
}

export interface WatchSnapshot {
  at: number;
  settings: WatchSettings;
  groups: WatchGroup[];
  alarms: WatchGroup[];
  /** Messages about sources that could not be read, so a silent gap is never mistaken for "all safe". */
  problems: string[];
}

export interface WatchConfig extends WatchSettings {
  watchReal: boolean;
  liveArmed: boolean;
  dryRun: boolean;
}

export interface WatchSources {
  /** The users to watch this round. */
  users(): Promise<string[]>;
  isOwner(userId: string): boolean;
  config(userId: string): Promise<WatchConfig>;
  bot(): Promise<WatchLeg[]>;
  paper(userId: string): Promise<WatchLeg[]>;
  /** Real Delta short legs for this user, or null when they have no key. Throws when Delta cannot be read. */
  real(userId: string, cfg: WatchSettings): Promise<WatchLeg[] | null>;
  /** Called when a group of real legs has reached the hard-exit distance. */
  hardExit?(userId: string, group: WatchGroup, cfg: WatchConfig): Promise<void>;
}

const keyOf = (userId: string, l: Pick<WatchLeg, 'source' | 'group' | 'symbol'>) => `${userId}|${l.source}|${l.group}|${l.symbol}`;

export class WatchService {
  private snaps = new Map<string, WatchSnapshot>();
  private prev = new Map<string, Level>();
  private since = new Map<string, number>();
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  lastError: string | null = null;

  constructor(private readonly src: WatchSources, private readonly now: () => number = Date.now) {}

  start(everyMs = 5_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshotFor(userId: string): WatchSnapshot | null {
    return this.snaps.get(userId) ?? null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let bot: WatchLeg[] = [];
      let botProblem: string | null = null;
      try { bot = await this.src.bot(); } catch (e) { botProblem = `bot positions unreadable: ${(e as Error).message}`; }
      for (const uid of await this.src.users()) {
        try { await this.one(uid, bot, botProblem); } catch (e) { this.lastError = `${uid}: ${(e as Error).message}`; }
      }
    } finally {
      this.running = false;
    }
  }

  private async one(uid: string, bot: WatchLeg[], botProblem: string | null): Promise<void> {
    const cfg = await this.src.config(uid);
    const problems: string[] = [];
    const legs: WatchLeg[] = [];
    if (this.src.isOwner(uid)) { legs.push(...bot); if (botProblem) problems.push(botProblem); }
    try { legs.push(...(await this.src.paper(uid))); } catch (e) { problems.push(`paper positions unreadable: ${(e as Error).message}`); }
    if (cfg.watchReal) {
      try { const r = await this.src.real(uid, cfg); if (r) legs.push(...r); } catch (e) { problems.push(`Delta positions unreadable: ${(e as Error).message}`); }
    }
    const t = this.now();
    const byGroup = new Map<string, { head: WatchLeg; list: LegStatus[] }>();
    const live = new Set<string>();
    for (const l of legs) {
      const k = keyOf(uid, l); live.add(k);
      const st = statusOf(l, cfg, this.prev.get(k) ?? 'safe');
      this.prev.set(k, st.level);
      const gk = `${uid}|${l.source}|${l.group}`;
      (byGroup.get(gk) ?? byGroup.set(gk, { head: l, list: [] }).get(gk)!).list.push(st);
    }
    for (const k of [...this.prev.keys()]) if (k.startsWith(uid + '|') && !live.has(k)) this.prev.delete(k);
    const groups: WatchGroup[] = [];
    for (const [gk, g] of byGroup) {
      const level = worst(g.list.map((x) => x.level));
      if (isAlarm(level)) { if (!this.since.has(gk)) this.since.set(gk, t); } else this.since.delete(gk);
      groups.push({
        id: gk.slice(uid.length + 1), source: g.head.source, label: g.head.groupLabel, level, since: this.since.get(gk) ?? null,
        legs: g.list.map((x) => ({ symbol: x.symbol, side: x.side, lots: x.lots, entry: x.entry, mark: x.mark, stop: x.stop, pointsLeft: x.pointsLeft, level: x.level })),
      });
    }
    for (const gk of [...this.since.keys()]) if (gk.startsWith(uid + '|') && !byGroup.has(gk)) this.since.delete(gk);
    groups.sort((a, b) => (isAlarm(b.level) ? 1 : 0) - (isAlarm(a.level) ? 1 : 0) || a.label.localeCompare(b.label));
    this.snaps.set(uid, { at: t, settings: { warnPoints: cfg.warnPoints, hardPoints: cfg.hardPoints, stopMultiple: cfg.stopMultiple }, groups, alarms: groups.filter((g) => isAlarm(g.level)), problems });
    // a real position at the hard-exit distance: hand it to the live exit (which has its own locks)
    if (this.src.hardExit) {
      for (const g of groups) {
        if (g.source === 'delta' && g.legs.some((l) => l.level === 'hard' || l.level === 'breach')) await this.src.hardExit(uid, g, cfg).catch((e) => { this.lastError = `hard exit: ${(e as Error).message}`; });
      }
    }
  }
}
