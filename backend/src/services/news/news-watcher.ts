/**
 * 24/7 shock alert (server side, runs whether or not the terminal is open).
 *
 * Every ~45-120 s it reads several public news feeds, classifies each headline, merges the same story from many
 * sources into one event, and watches BTC for abnormal moves. Then:
 *   CRITICAL headline (hack, withdrawal halt, depeg, insolvency, ban, war)
 *       → full-screen popup "CLOSE ALL OPEN POSITIONS · No new entries" + Telegram + ntfy + push
 *   HIGH headline → amber popup "Consider closing or halving · No new entries"
 *   abnormal BTC move with no headline → amber popup "Unexplained move · watch"; a headline that arrives later is
 *       linked to it
 *   every source failing → one "News feed down" message
 *
 * It never places, closes or blocks an order. Sources are public RSS feeds and public JSON APIs only.
 */
import { randomUUID } from 'node:crypto';
import { classifyHeadline, type Category, type Severity } from '../../lib/news/classify.js';
import { parseFeed, safeLink, type FeedItem } from '../../lib/news/rss.js';
import { sameStory } from '../../lib/news/cluster.js';
import { judgeMove, readMove, DEFAULT_MOVE, type MoveRead, type PricePoint } from '../../lib/news/move.js';

const SEC = 1000, MIN = 60 * SEC, H = 60 * MIN;

export interface NewsSourceRef { name: string; link: string; at: number }

export interface NewsEvent {
  id: string;
  kind: 'headline' | 'anomaly' | 'tripwire';
  severity: Severity;
  category: Category;
  reason: string;
  title: string;
  link: string;
  entities: string[];
  sources: NewsSourceRef[];
  firstSeen: number;
  publishedAt: number | null;
  /** BTC 15-min move when the alert went out (or the anomaly itself). */
  move: MoveRead | null;
  alertedAt: number | null;
  ackedAt: number | null;
  /** Headline ↔ anomaly link. */
  linkedId: string | null;
}

export interface NewsStore {
  load(sinceMs: number): Promise<NewsEvent[]>;
  save(e: NewsEvent): Promise<void>;
}

export interface Notification { title: string; message: string; severity: Severity; telegram: boolean }

export interface SourceDef {
  id: string;
  name: string;
  url: string;
  kind: 'rss' | 'breaking' | 'hacks';
  everyMs: number;
}

const gn = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

/** Public feeds only. Each is polled no faster than about once a minute. */
export const DEFAULT_SOURCES: SourceDef[] = [
  { id: 'fcn', name: 'Free Crypto News', url: 'https://cryptocurrency.cv/api/breaking', kind: 'breaking', everyMs: 45 * SEC },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', kind: 'rss', everyMs: 60 * SEC },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', kind: 'rss', everyMs: 60 * SEC },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', kind: 'rss', everyMs: 60 * SEC },
  { id: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed', kind: 'rss', everyMs: 90 * SEC },
  { id: 'gn-shock', name: 'Google News', url: gn('(crypto exchange) (hack OR hacked OR exploit OR drained OR "withdrawals" OR insolvent OR outage) when:1h'), kind: 'rss', everyMs: 60 * SEC },
  { id: 'gn-depeg', name: 'Google News', url: gn('(stablecoin OR tether OR usdc) (depeg OR "loses peg") when:1h'), kind: 'rss', everyMs: 90 * SEC },
  { id: 'gn-btc', name: 'Google News', url: gn('bitcoin when:1h'), kind: 'rss', everyMs: 90 * SEC },
  { id: 'gn-war', name: 'Google News', url: gn('("declares war" OR "missile strike" OR invasion OR "nuclear") when:1h'), kind: 'rss', everyMs: 120 * SEC },
  { id: 'bbc', name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', kind: 'rss', everyMs: 120 * SEC },
  { id: 'llama', name: 'DeFiLlama hacks', url: 'https://api.llama.fi/hacks', kind: 'hacks', everyMs: 10 * MIN },
];

export interface NewsWatcherDeps {
  now(): number;
  fetchText(url: string): Promise<string>;
  spot(): number | null;
  notify(n: Notification): Promise<void>;
  broadcast(type: 'news_alert' | 'news_update' | 'news_ack', event: NewsEvent): void;
  store: NewsStore;
  /** Optional price history to seed the move baseline at start. */
  seedPrices?(): Promise<PricePoint[]>;
}

export interface SourceHealth { id: string; name: string; lastOkAt: number | null; lastItemAt: number | null; lastError: string; errors: number }

/** How long "No new entries" lasts after an alert. */
export const NO_ENTRY_MS: Record<Severity, number> = { CRITICAL: 6 * H, HIGH: 2 * H, MEDIUM: 0, LOW: 0 };
/** A headline older than this is stored but never pops up. */
const FRESH_MS = 30 * MIN;
/** Right after a (re)start the feeds hold an hour of headlines; only the very newest may pop up. */
const WARMUP_FRESH_MS = 10 * MIN;
/** Named incidents (an exchange hack, a depeg) stay one story this long, so follow-ups never alarm again. */
const INCIDENT_MS = 72 * H;
const STORY_MS = 6 * H;
const INCIDENTS = new Set<Category>(['exchange_hack', 'withdrawal_halt', 'depeg', 'insolvency']);
/** Events kept in memory (and reloaded at start) for matching follow-ups. */
const MEMORY_MS = 7 * 24 * H;
/** Items older than this are ignored entirely. */
const MAX_AGE_MS = 6 * H;
const ANOMALY_COOLDOWN_MS = 30 * MIN;
const LINK_WINDOW_MS = 60 * MIN;
const PRICE_KEEP_MS = 26 * H;
const FEED_DOWN_MS = 5 * MIN;

const RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function fmtIst(ms: number): string {
  const d = new Date(ms + 5.5 * H);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} IST`;
}

export function fmtMove(m: MoveRead | null): string {
  if (!m) return '';
  const sign = m.movePts >= 0 ? '+' : '−';
  return `BTC ${sign}${Math.round(Math.abs(m.movePts)).toLocaleString('en-US')} (${sign}${Math.abs(m.movePct).toFixed(1)}%) in 15 min, ${m.ratio.toFixed(1)}× a normal move`;
}

/** Telegram Markdown breaks on stray * _ [ ` in a headline; a broken message is a lost alert. */
const plain = (s: string) => s.replace(/[*_[\]`]/g, '');

export class NewsWatcher {
  readonly events: NewsEvent[] = [];
  readonly health = new Map<string, SourceHealth>();
  private prices: PricePoint[] = [];
  private seen = new Set<string>();
  private nextAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private startedAt = 0;
  private feedDownSent = false;
  private lastAnomalyAt = 0;
  private warmed = new Set<string>();

  constructor(private deps: NewsWatcherDeps, private sources: SourceDef[] = DEFAULT_SOURCES) {
    for (const s of sources) this.health.set(s.id, { id: s.id, name: s.name, lastOkAt: null, lastItemAt: null, lastError: '', errors: 0 });
  }

  async start(tickMs = 15 * SEC): Promise<void> {
    if (this.timer) return;
    this.startedAt = this.deps.now();
    try {
      const past = await this.deps.store.load(this.startedAt - MEMORY_MS);
      this.events.push(...past.sort((a, b) => a.firstSeen - b.firstSeen));
    } catch (e) {
      console.warn('[news] could not load past events:', e instanceof Error ? e.message : e);
    }
    if (this.deps.seedPrices) {
      try { this.prices = (await this.deps.seedPrices()).filter((p) => p.t > this.startedAt - PRICE_KEEP_MS); } catch { /* the baseline builds up live */ }
    }
    this.timer = setInterval(() => { void this.tick(); }, tickMs);
    await this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: sample price, poll due sources, check the move, check feed health. Safe to call directly in tests. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.deps.now();
      this.samplePrice(now);
      const due = this.sources.filter((s) => (this.nextAt.get(s.id) ?? 0) <= now);
      await Promise.all(due.map((s) => this.poll(s, now)));
      await this.checkMove(this.deps.now());
      await this.checkFeedHealth(this.deps.now());
      this.prune(this.deps.now());
    } finally {
      this.busy = false;
    }
  }

  private samplePrice(now: number): void {
    const p = this.deps.spot();
    if (p && Number.isFinite(p) && p > 0) {
      this.prices.push({ t: now, p });
      if (this.prices.length > 20_000) this.prices = this.prices.filter((x) => x.t > now - PRICE_KEEP_MS);
    }
  }

  private async poll(s: SourceDef, now: number): Promise<void> {
    this.nextAt.set(s.id, now + s.everyMs);
    const h = this.health.get(s.id)!;
    let items: FeedItem[];
    try {
      const body = await this.deps.fetchText(s.url);
      items = s.kind === 'rss' ? parseFeed(body) : s.kind === 'breaking' ? parseBreaking(body) : parseHacks(body);
      h.lastOkAt = now;
      h.lastError = '';
    } catch (e) {
      h.errors++;
      h.lastError = e instanceof Error ? e.message : String(e);
      return;
    }
    const freshMs = this.warmed.has(s.id) ? FRESH_MS : WARMUP_FRESH_MS;
    // oldest first, so a story's first report is the one that starts it
    for (const it of [...items].sort((a, b) => (a.publishedAt ?? now) - (b.publishedAt ?? now))) {
      if (it.publishedAt) h.lastItemAt = Math.max(h.lastItemAt ?? 0, it.publishedAt);
      await this.ingest(it, s, now, freshMs);
    }
    this.warmed.add(s.id);
  }

  /** Classify one item and either add it to an existing story or start a new one (and alert when fresh). */
  async ingest(it: FeedItem, s: SourceDef, now: number, freshMs = FRESH_MS): Promise<void> {
    const seenKey = `${s.id}|${it.link || it.title}`;
    if (this.seen.has(seenKey)) return;
    this.seen.add(seenKey);
    const at = it.publishedAt ?? now;
    if (at < now - MAX_AGE_MS || at > now + 10 * MIN) return;
    const c = classifyHeadline(it.title, it.summary);
    if (!c) return;
    const sourceName = it.source || s.name;
    const ref: NewsSourceRef = { name: sourceName, link: it.link, at };

    const matches = this.events.filter((e) => e.kind === 'headline' && sameStory(it.title, c.category, c.entities, at,
      // measured from the latest mention: while coverage continues, the incident stays one story
      { title: e.title, category: e.category, entities: e.entities, firstSeen: Math.max(e.publishedAt ?? e.firstSeen, ...e.sources.map((x) => x.at)) },
      INCIDENTS.has(e.category) ? INCIDENT_MS : STORY_MS));
    // prefer the story of the same kind (a Binance hack report joins the Binance hack, not an unrelated wallet hack)
    // a more serious report of a different kind is its own story
    const story = matches.find((e) => e.category === c.category)
      ?? matches.find((e) => RANK[c.severity] <= RANK[e.severity]);
    if (story) {
      const known = story.sources.find((x) => x.name.toLowerCase() === sourceName.toLowerCase());
      const newSource = !known;
      if (newSource) story.sources.push(ref);
      // every mention keeps the story alive (the incident window runs from the latest one)
      const fresher = !!known && at > known.at;
      if (known && fresher) known.at = at;
      // only a report of the same kind may raise a story's level; a different kind never relabels it
      const upgraded = c.category === story.category && RANK[c.severity] > RANK[story.severity];
      if (upgraded) Object.assign(story, { severity: c.severity, reason: c.reason });
      if (!newSource && !upgraded) {
        if (fresher) await this.save(story);
        return;
      }
      await this.save(story);
      if (upgraded && !story.alertedAt && RANK[story.severity] >= RANK.HIGH && at >= now - freshMs) {
        await this.alert(story, now); // first time it became CRITICAL/HIGH
      } else if (newSource && story.alertedAt && story.sources.length === 2) {
        this.deps.broadcast('news_update', story);
        await this.deps.notify({
          title: `Confirmed: ${story.reason}`,
          message: `${plain(story.title)}\nNow reported by ${story.sources.map((x) => plain(x.name)).join(', ')}.`,
          severity: story.severity, telegram: true,
        });
      } else if (story.alertedAt) {
        this.deps.broadcast('news_update', story);
      }
      return;
    }

    const e: NewsEvent = {
      id: randomUUID(), kind: 'headline', severity: c.severity, category: c.category, reason: c.reason, title: it.title,
      link: it.link, entities: c.entities, sources: [ref], firstSeen: now, publishedAt: it.publishedAt, move: null,
      alertedAt: null, ackedAt: null, linkedId: null,
    };
    this.events.push(e);
    if (RANK[e.severity] >= RANK.HIGH && at >= now - freshMs) await this.alert(e, now);
    else await this.save(e);
  }

  private async alert(e: NewsEvent, now: number): Promise<void> {
    e.alertedAt = now;
    e.move = readMove(this.prices, now);
    const abnormal = judgeMove(e.move, true) === 'shock';
    // a recent unexplained move that this headline explains
    const anomaly = [...this.events].reverse().find((a) => a.kind === 'anomaly' && !a.linkedId && now - a.firstSeen <= LINK_WINDOW_MS);
    if (anomaly) { anomaly.linkedId = e.id; e.linkedId = anomaly.id; await this.save(anomaly); this.deps.broadcast('news_update', anomaly); }
    await this.save(e);
    this.deps.broadcast('news_alert', e);

    const srcs = e.sources.map((x) => plain(x.name)).join(', ');
    const confirm = e.sources.length >= 2 ? `Confirmed by ${e.sources.length} sources` : 'Unconfirmed, verify';
    const moveLine = e.move ? fmtMove(e.move) + (abnormal ? '. The move has news behind it: treat it as real, not a spike.' : '.') : '';
    const lines = [plain(e.title), `${e.reason} · ${srcs} · ${confirm} · ${fmtIst(e.publishedAt ?? now)}`];
    if (moveLine) lines.push(moveLine);
    if (anomaly) lines.push(`This explains the unexplained move at ${fmtIst(anomaly.firstSeen)}.`);
    if (e.severity === 'CRITICAL') {
      lines.push('', 'CLOSE ALL OPEN POSITIONS. No new entries for the next 6 hours.');
      await this.deps.notify({ title: 'CLOSE ALL OPEN POSITIONS', message: lines.join('\n'), severity: 'CRITICAL', telegram: true });
    } else {
      lines.push('', 'Consider closing or halving open positions. No new entries until the move settles.');
      await this.deps.notify({ title: `HIGH: ${e.reason}`, message: lines.join('\n'), severity: 'HIGH', telegram: true });
    }
  }

  /** Abnormal BTC move with no CRITICAL/HIGH headline in the last hour → "Unexplained move". */
  private async checkMove(now: number): Promise<void> {
    const read = readMove(this.prices, now);
    if (!read || judgeMove(read, false) === 'normal') return;
    if (now - this.lastAnomalyAt < ANOMALY_COOLDOWN_MS) return;
    const explained = this.events.some((e) => e.kind === 'headline' && e.alertedAt && now - e.alertedAt <= LINK_WINDOW_MS);
    this.lastAnomalyAt = now;
    if (explained) return; // the headline popup already said "close"; one popup per shock
    const down = read.movePct < 0;
    const e: NewsEvent = {
      id: randomUUID(), kind: 'anomaly', severity: 'HIGH', category: 'crash',
      reason: down ? 'Unexplained fall' : 'Unexplained rise',
      title: `${fmtMove(read)}. No headline yet.`, link: '', entities: ['btc'], sources: [], firstSeen: now, publishedAt: now,
      move: read, alertedAt: now, ackedAt: null, linkedId: null,
    };
    this.events.push(e);
    await this.save(e);
    this.deps.broadcast('news_alert', e);
    await this.deps.notify({
      title: `Unexplained move: BTC ${down ? 'falling' : 'rising'} fast`,
      message: `${e.title}\nNo news found yet. Watch closely: news often follows. If a headline arrives you get a separate alert at once.\nNo new entries until it settles.`,
      severity: 'HIGH', telegram: true,
    });
  }

  private async checkFeedHealth(now: number): Promise<void> {
    if (now - this.startedAt < FEED_DOWN_MS) return;
    const down = this.feedDown(now);
    if (down && !this.feedDownSent) {
      this.feedDownSent = true;
      await this.deps.notify({ title: 'News feed down', message: 'Every news source is failing. Shock alerts are unavailable until it recovers.', severity: 'HIGH', telegram: true });
    } else if (!down && this.feedDownSent) {
      this.feedDownSent = false;
      await this.deps.notify({ title: 'News feed back', message: 'News sources are answering again. Shock alerts are working.', severity: 'LOW', telegram: true });
    }
  }

  feedDown(now = this.deps.now()): boolean {
    return [...this.health.values()].every((h) => !h.lastOkAt || now - h.lastOkAt > FEED_DOWN_MS);
  }

  private prune(now: number): void {
    const keep = now - MEMORY_MS;
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].firstSeen < keep) this.events.splice(i, 1);
    if (this.seen.size > 20_000) this.seen.clear(); // items older than MAX_AGE are skipped anyway
    this.prices = this.prices.filter((x) => x.t > now - PRICE_KEEP_MS);
  }

  private async save(e: NewsEvent): Promise<void> {
    try { await this.deps.store.save(e); } catch (err) { console.warn('[news] save failed:', err instanceof Error ? err.message : err); }
  }

  /**
   * An alert from another part of the desk (the compression-break tripwire) through the same popup, store and Telegram
   * path, so it is acknowledged and caught up on exactly like a news shock.
   */
  async raise(a: { kind: 'tripwire'; severity: 'CRITICAL' | 'HIGH'; category: Category; reason: string; title: string; message: string }): Promise<NewsEvent> {
    const now = this.deps.now();
    const e: NewsEvent = {
      id: randomUUID(), kind: a.kind, severity: a.severity, category: a.category, reason: a.reason, title: a.title, link: '',
      entities: ['btc'], sources: [], firstSeen: now, publishedAt: now, move: readMove(this.prices, now), alertedAt: now, ackedAt: null, linkedId: null,
    };
    this.events.push(e);
    await this.save(e);
    this.deps.broadcast('news_alert', e);
    await this.deps.notify({ title: a.reason.toUpperCase(), message: `${plain(a.title)}\n\n${a.message}`, severity: a.severity, telegram: true });
    return e;
  }

  /**
   * A labelled test alert through the real alert path (store, socket, notify). The route only exists with
   * NEWS_DEMO=true, which only the local test stack sets.
   */
  async demo(kind: 'hack' | 'fall'): Promise<NewsEvent> {
    const now = this.deps.now();
    const move: MoveRead = { movePct: -2.8, movePts: -2712, ratio: 7.4, normalPct: 0.38 };
    if (kind === 'fall') {
      const e: NewsEvent = {
        id: randomUUID(), kind: 'anomaly', severity: 'HIGH', category: 'crash', reason: 'Unexplained fall (DEMO)',
        title: `DEMO: ${fmtMove(move)}. No headline yet.`, link: '', entities: ['btc'], sources: [], firstSeen: now, publishedAt: now,
        move, alertedAt: now, ackedAt: null, linkedId: null,
      };
      this.events.push(e);
      await this.save(e);
      this.deps.broadcast('news_alert', e);
      return e;
    }
    const e: NewsEvent = {
      id: randomUUID(), kind: 'headline', severity: 'CRITICAL', category: 'exchange_hack', reason: 'Exchange hack (DEMO)',
      title: 'DEMO: Binance Drained of $5.5 Billion in Suspected Hack, Tether and Circle Freeze $1.8 Billion', link: 'https://www.theblock.co',
      entities: ['binance'], sources: [{ name: 'The Block', link: '', at: now - 120_000 }, { name: 'Reuters', link: '', at: now - 60_000 }],
      firstSeen: now, publishedAt: now - 150_000, move: null, alertedAt: null, ackedAt: null, linkedId: null,
    };
    this.events.push(e);
    await this.alert(e, now);
    return e;
  }

  /** Unacknowledged CRITICAL/HIGH alerts from the last 12 h, newest first (the popup queue). */
  active(now = this.deps.now()): NewsEvent[] {
    return this.events.filter((e) => e.alertedAt && !e.ackedAt && now - e.alertedAt <= 12 * H && RANK[e.severity] >= RANK.HIGH)
      .sort((a, b) => (b.alertedAt ?? 0) - (a.alertedAt ?? 0));
  }

  recent(limit = 100): NewsEvent[] {
    return [...this.events].sort((a, b) => (b.publishedAt ?? b.firstSeen) - (a.publishedAt ?? a.firstSeen)).slice(0, limit);
  }

  async ack(id: string): Promise<NewsEvent | null> {
    const e = this.events.find((x) => x.id === id);
    if (!e) return null;
    if (!e.ackedAt) { e.ackedAt = this.deps.now(); await this.save(e); this.deps.broadcast('news_ack', e); }
    return e;
  }

  /** For gates and the terminal: the "No new entries" window from the latest alert. Nothing is blocked automatically. */
  status(now = this.deps.now()) {
    let noNewEntriesUntil: number | null = null;
    let level: Severity | null = null;
    for (const e of this.events) {
      if (!e.alertedAt) continue;
      const until = e.alertedAt + NO_ENTRY_MS[e.severity];
      if (until > now && (!noNewEntriesUntil || until > noNewEntriesUntil)) { noNewEntriesUntil = until; level = e.severity; }
    }
    return {
      level, noNewEntriesUntil, feedDown: this.feedDown(now), move: readMove(this.prices, now), thresholds: DEFAULT_MOVE,
      sources: [...this.health.values()],
    };
  }
}

/** cryptocurrency.cv /api/breaking: {articles:[{title, link, pubDate, source}]} */
export function parseBreaking(body: string): FeedItem[] {
  const j = JSON.parse(body) as { articles?: any[] } | any[];
  const arr = Array.isArray(j) ? j : Array.isArray(j?.articles) ? j.articles : [];
  return arr.filter((x: any) => x && x.title).map((x: any) => {
    const t = Date.parse(x.pubDate || x.publishedAt || x.date || '');
    return { title: String(x.title).trim(), link: safeLink(String(x.link || x.url || '')), publishedAt: Number.isFinite(t) ? t : null, summary: String(x.description || '').slice(0, 400), source: String(x.source || '') };
  });
}

const HACK_MIN_USD = 20_000_000;

/** api.llama.fi/hacks: [{date (unix s), name, amount, classification}]. Only the newest ones matter. */
export function parseHacks(body: string): FeedItem[] {
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) return [];
  // small DeFi hacks happen every week and do not move BTC; only big ones pop up
  return arr.filter((h: any) => h && h.name && Number(h.date) > 0 && Number(h.amount) >= HACK_MIN_USD).sort((a: any, b: any) => b.date - a.date).slice(0, 30).map((h: any) => {
    const amt = Number(h.amount) || 0;
    const usd = amt >= 1e9 ? `$${(amt / 1e9).toFixed(1)}B` : amt >= 1e6 ? `$${Math.round(amt / 1e6)}M` : amt ? `$${Math.round(amt / 1e3)}K` : '';
    return {
      title: `${h.name} crypto hack${usd ? `: ${usd} stolen` : ''}`,
      link: 'https://defillama.com/hacks', publishedAt: Number(h.date) * 1000, summary: String(h.technique || ''), source: 'DeFiLlama',
    };
  });
}
