import { describe, expect, it } from 'vitest';
import { NewsWatcher, parseHacks, type NewsEvent, type Notification, type SourceDef } from './news-watcher.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-30T20:20:00Z'); // Fri 01:50 IST

function rss(items: { title: string; link: string; at: number; source?: string }[]): string {
  return `<rss><channel>${items.map((i) => `<item><title>${i.title}${i.source ? ` - ${i.source}` : ''}</title><link>${i.link}</link><pubDate>${new Date(i.at).toUTCString()}</pubDate>${i.source ? `<source>${i.source}</source>` : ''}</item>`).join('')}</channel></rss>`;
}

function setup() {
  let now = T0;
  let price = 100_000;
  const feeds: Record<string, string> = { a: rss([]), b: rss([]) };
  const failing = new Set<string>();
  const notes: Notification[] = [];
  const casts: { type: string; event: NewsEvent }[] = [];
  const saved = new Map<string, NewsEvent>();
  const sources: SourceDef[] = [
    { id: 'a', name: 'Feed A', url: 'a', kind: 'rss', everyMs: MIN },
    { id: 'b', name: 'Feed B', url: 'b', kind: 'rss', everyMs: MIN },
  ];
  // 24 h of quiet price history, one point a minute
  const history = Array.from({ length: 24 * 60 }, (_, i) => ({ t: T0 - (24 * 60 - i) * MIN, p: 100_000 + 60 * Math.sin(i / 9) }));
  const w = new NewsWatcher({
    now: () => now,
    fetchText: async (url) => { if (failing.has(url)) throw new Error('down'); return feeds[url]; },
    spot: () => price,
    notify: async (n) => { notes.push(n); },
    broadcast: (type, event) => { casts.push({ type, event: { ...event } }); },
    store: { load: async () => [...saved.values()], save: async (e) => { saved.set(e.id, { ...e }); } },
    seedPrices: async () => history,
  }, sources);
  return {
    w, notes, casts, saved, feeds, failing,
    advance: (ms: number) => { now += ms; },
    setPrice: (p: number) => { price = p; },
    get now() { return now; },
  };
}

describe('NewsWatcher', () => {
  it('a fresh exchange hack pops up "CLOSE ALL OPEN POSITIONS" once, and a second source confirms it', async () => {
    const s = setup();
    await s.w.start(1e9);
    s.feeds.a = rss([{ title: 'Binance hacked: attackers drain $400M from hot wallet', link: 'https://a/1', at: s.now - 2 * MIN }]);
    s.advance(MIN);
    await s.w.tick();

    const popups = s.casts.filter((c) => c.type === 'news_alert');
    expect(popups).toHaveLength(1);
    expect(popups[0].event.severity).toBe('CRITICAL');
    expect(s.notes[0].title).toBe('CLOSE ALL OPEN POSITIONS');
    expect(s.notes[0].message).toContain('No new entries');
    expect(s.notes[0].message).toContain('Unconfirmed');
    expect(s.w.active()).toHaveLength(1);

    // the same story from a second source: no second popup, one "Confirmed" message
    s.feeds.b = rss([{ title: 'Hackers hit Binance in major security breach', link: 'https://b/9', at: s.now - MIN, source: 'Reuters' }]);
    s.advance(MIN);
    await s.w.tick();
    expect(s.casts.filter((c) => c.type === 'news_alert')).toHaveLength(1);
    expect(s.notes.map((n) => n.title)).toContain('Confirmed: Exchange hack: Binance');
    expect(s.w.active()[0].sources).toHaveLength(2);
    s.w.stop();
  });

  it('old headlines and harmless "hack" stories never pop up', async () => {
    const s = setup();
    await s.w.start(1e9);
    s.feeds.a = rss([
      { title: 'Binance hacked in overnight exploit', link: 'https://a/old', at: s.now - 3 * 60 * MIN },
      { title: 'Ten growth hacks every crypto startup should know', link: 'https://a/gh', at: s.now - MIN },
      { title: 'Bitcoin holds steady near $100,000', link: 'https://a/low', at: s.now - MIN },
    ]);
    s.advance(MIN);
    await s.w.tick();
    expect(s.casts.filter((c) => c.type === 'news_alert')).toHaveLength(0);
    expect(s.notes).toHaveLength(0);
    expect(s.w.recent().length).toBe(3); // all stored for review
    s.w.stop();
  });

  it('a sharp fall with no headline is an "Unexplained move"; the headline that follows is linked to it', async () => {
    const s = setup();
    await s.w.start(1e9);
    // BTC falls 2,700 over 15 minutes
    for (let m = 1; m <= 15; m++) { s.advance(MIN); s.setPrice(100_000 - 180 * m); await s.w.tick(); }
    const anomaly = s.casts.find((c) => c.type === 'news_alert' && c.event.kind === 'anomaly');
    expect(anomaly).toBeTruthy();
    expect(anomaly!.event.reason).toBe('Unexplained fall');
    expect(s.notes.at(-1)!.title).toContain('Unexplained move');

    s.feeds.a = rss([{ title: 'Binance suspends withdrawals after security incident', link: 'https://a/2', at: s.now - MIN }]);
    s.advance(MIN);
    await s.w.tick();
    const hit = s.casts.filter((c) => c.type === 'news_alert').at(-1)!;
    expect(hit.event.severity).toBe('CRITICAL');
    expect(hit.event.linkedId).toBe(anomaly!.event.id);
    const msg = s.notes.at(-1)!.message;
    expect(msg).toContain('CLOSE ALL OPEN POSITIONS');
    expect(msg).toContain('treat it as real, not a spike');
    expect(msg).toContain('explains the unexplained move');
    s.w.stop();
  });

  it('acknowledging clears the popup queue but keeps the "No new entries" window', async () => {
    const s = setup();
    await s.w.start(1e9);
    s.feeds.a = rss([{ title: 'USDC loses its dollar peg', link: 'https://a/3', at: s.now }]);
    s.advance(MIN);
    await s.w.tick();
    const id = s.w.active()[0].id;
    await s.w.ack(id);
    expect(s.w.active()).toHaveLength(0);
    expect(s.casts.at(-1)!.type).toBe('news_ack');
    const st = s.w.status();
    expect(st.level).toBe('CRITICAL');
    expect(st.noNewEntriesUntil! - s.now).toBeGreaterThan(5 * 60 * MIN);
    s.w.stop();
  });

  it('a restart does not repeat an alert that was already sent', async () => {
    const s = setup();
    await s.w.start(1e9);
    s.feeds.a = rss([{ title: 'Kraken halts withdrawals', link: 'https://a/4', at: s.now }]);
    s.advance(MIN);
    await s.w.tick();
    s.w.stop();
    const before = s.notes.length;

    // new watcher over the same store and feed
    const again = new NewsWatcher({
      now: () => s.now + 2 * MIN, fetchText: async () => s.feeds.a, spot: () => 100_000,
      notify: async (n) => { s.notes.push(n); }, broadcast: () => {},
      store: { load: async () => [...s.saved.values()], save: async () => {} },
    }, [{ id: 'a', name: 'Feed A', url: 'a', kind: 'rss', everyMs: MIN }]);
    await again.start(1e9);
    await again.tick();
    again.stop();
    expect(s.notes.length).toBe(before);
  });

  it('a follow-up on a known exchange hack two days later does not alarm again', async () => {
    const s = setup();
    await s.w.start(1e9);
    s.feeds.a = rss([{ title: 'Binance hacked: attackers drain $400M from hot wallet', link: 'https://a/5', at: s.now }]);
    s.advance(MIN);
    await s.w.tick();
    expect(s.casts.filter((c) => c.type === 'news_alert')).toHaveLength(1);
    s.advance(48 * 60 * MIN);
    s.feeds.b = rss([{ title: 'Binance hack: exchange says stolen funds traced', link: 'https://b/6', at: s.now - MIN, source: 'CoinDesk' }]);
    await s.w.tick();
    expect(s.casts.filter((c) => c.type === 'news_alert')).toHaveLength(1);
    s.w.stop();
  });

  it('right after a restart only the newest headlines may pop up', async () => {
    const s = setup();
    s.feeds.a = rss([{ title: 'Kraken halts withdrawals', link: 'https://a/7', at: T0 - 20 * MIN }]);
    await s.w.start(1e9); // first read of the feed happens here
    expect(s.casts).toHaveLength(0);
    expect(s.w.recent()).toHaveLength(1); // stored, not shown
    s.w.stop();
  });

  it('a different kind of hack never joins and relabels another story', async () => {
    const s = setup();
    await s.w.start(1e9);
    s.feeds.a = rss([{ title: 'BTCPay Server Hack: Bitcoin Hot Wallets Drained, Shut Your Server Down Now', link: 'https://a/8', at: s.now }]);
    s.advance(MIN);
    await s.w.tick();
    s.feeds.b = rss([{ title: 'Binance hot wallets drained in hack', link: 'https://b/8', at: s.now, source: 'Reuters' }]);
    s.advance(MIN);
    await s.w.tick();
    const alerts = s.casts.filter((c) => c.type === 'news_alert').map((c) => `${c.event.reason} | ${c.event.title}`);
    expect(alerts).toEqual(['Exchange hack: Binance | Binance hot wallets drained in hack']);
    s.w.stop();
  });

  it('reports "News feed down" once when every source fails, and "back" when they recover', async () => {
    const s = setup();
    await s.w.start(1e9);
    s.failing.add('a'); s.failing.add('b');
    for (let i = 0; i < 7; i++) { s.advance(MIN); await s.w.tick(); }
    expect(s.notes.filter((n) => n.title === 'News feed down')).toHaveLength(1);
    s.failing.clear();
    s.advance(MIN);
    await s.w.tick();
    expect(s.notes.at(-1)!.title).toBe('News feed back');
    s.w.stop();
  });
});

// The real Binance incident as the feeds carried it (UTC): the first report must alarm once; four days of coverage must not.
const BINANCE_COVERAGE: [string, string][] = [
  ['2026-10-29T21:36:00Z', 'Binance Drained of $5.5 Billion in Suspected Hack, Tether and Circle Freeze $1.8 Billion'],
  ['2026-10-29T21:49:00Z', 'Binance investigating hack as suspicious outflows reach up to $5.8 billion'],
  ['2026-10-29T22:57:00Z', 'Binance Hacker Hunts for Exit Ramps as DeFi Exchanges Pause Markets'],
  ['2026-10-30T02:22:00Z', 'Bitcoin slides below $77,000, BNB drops amid Binance hack'],
  ['2026-10-30T09:31:00Z', "Binance Finds 'Additional Points of Breach' in $6.3B Hack"],
  ['2026-10-30T12:22:00Z', "TRM and Chainalysis Tie $6.4B Binance Hack to North Korea's TraderTraitor"],
  ['2026-10-30T16:53:00Z', 'Recap: How Binance’s record $6.3B hack unfolded'],
  ['2026-10-30T22:00:00Z', 'Binance hackers raced to move billions before it could be frozen'],
  ['2026-10-31T12:00:00Z', 'The $6.3 billion Binance hack paradox: Centralization made the hack possible, but also saved $3 billion'],
  ['2026-10-31T15:36:00Z', 'Binance says 90% of stolen assets replenished, targets Sunday withdrawals'],
  ['2026-11-01T07:44:00Z', 'FBI blames North Korea for record $6.3B Binance hack'],
  ['2026-11-01T18:25:00Z', 'North Korean hackers launder $242 million of Binance loot via Tron as FBI presses THORChain: analyst'],
  ['2026-11-02T08:01:00Z', 'North Korea Hacked And Heisted Binance'],
  ['2026-11-02T08:17:00Z', 'Blockchain Firms Link North Korea to $6.3 Billion Binance Hack'],
];

describe('replay: the Binance hack, 29 Oct - 2 Nov 2026', () => {
  it('one "CLOSE ALL OPEN POSITIONS" at the first report, nothing for the coverage that follows', async () => {
    let now = Date.parse('2026-10-29T21:00:00Z');
    let feed = rss([]);
    const notes: Notification[] = [];
    const popups: NewsEvent[] = [];
    const w = new NewsWatcher({
      now: () => now, fetchText: async () => feed, spot: () => null,
      notify: async (n) => { notes.push(n); }, broadcast: (type, e) => { if (type === 'news_alert') popups.push({ ...e }); },
      store: { load: async () => [], save: async () => {} },
    }, [{ id: 'a', name: 'Feed', url: 'a', kind: 'rss', everyMs: MIN }]);
    await w.start(1e9);
    const shown: { title: string; link: string; at: number }[] = [];
    for (const [iso, title] of BINANCE_COVERAGE) {
      const at = Date.parse(iso);
      now = at + 90_000; // read 90 s after publication
      shown.unshift({ title, link: `https://x/${at}`, at });
      feed = rss(shown.slice(0, 20));
      await w.tick();
    }
    w.stop();
    expect(popups.map((p) => `${p.severity} ${p.category} ${p.title}`)).toEqual([expect.stringContaining("Binance Drained")]);
    expect(popups[0].title).toContain('Binance Drained');
    expect(notes.filter((n) => n.title === 'CLOSE ALL OPEN POSITIONS')).toHaveLength(1);
  });
});

describe('parseHacks', () => {
  it('keeps only big hacks and names them as crypto hacks', () => {
    const items = parseHacks(JSON.stringify([
      { date: 1_800_000_000, name: 'Bybit', amount: 1.4e9 },
      { date: 1_800_000_100, name: 'TinyFarm', amount: 200_000 },
    ]));
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Bybit crypto hack: $1.4B stolen');
  });
});
