import { describe, expect, it } from 'vitest';
import { parseFeed } from './rss.js';
import { overlap, sameStory, words } from './cluster.js';
import { judgeMove, readMove, type PricePoint } from './move.js';

describe('parseFeed', () => {
  it('reads RSS items with CDATA and entities', () => {
    const xml = `<rss><channel><title>X</title>
      <item><title><![CDATA[Binance hacked &amp; drained]]></title><link>https://a.com/1</link>
        <pubDate>Fri, 30 Oct 2026 20:31:00 GMT</pubDate><description><![CDATA[<p>Hot wallet</p>]]></description></item>
      <item><title>Second</title><link>https://a.com/2</link></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Binance hacked & drained');
    expect(items[0].link).toBe('https://a.com/1');
    expect(items[0].publishedAt).toBe(Date.parse('2026-10-30T20:31:00Z'));
    expect(items[0].summary).toBe('Hot wallet');
    expect(items[1].publishedAt).toBeNull();
  });

  it('splits the Google News source suffix', () => {
    const xml = `<rss><channel><item><title>Binance halts withdrawals - Reuters</title><link>https://n.g/1</link>
      <source url="https://reuters.com">Reuters</source></item></channel></rss>`;
    const [it0] = parseFeed(xml);
    expect(it0.title).toBe('Binance halts withdrawals');
    expect(it0.source).toBe('Reuters');
  });

  it('drops javascript: and data: links', () => {
    const xml = `<rss><channel><item><title>A</title><link>javascript:alert(1)</link></item>
      <item><title>B</title><link>data:text/html,x</link></item><item><title>C</title><link>https://ok.com/c</link></item></channel></rss>`;
    expect(parseFeed(xml).map((i) => i.link)).toEqual(['', '', 'https://ok.com/c']);
  });

  it('reads Atom entries', () => {
    const xml = `<feed><entry><title>Atom one</title><link rel="alternate" href="https://b.com/x"/>
      <updated>2026-11-01T10:00:00Z</updated></entry></feed>`;
    const [e] = parseFeed(xml);
    expect(e.link).toBe('https://b.com/x');
    expect(e.publishedAt).toBe(Date.parse('2026-11-01T10:00:00Z'));
  });
});

describe('sameStory', () => {
  const ref = { title: 'Binance hacked: attackers drain $400M from hot wallet', category: 'exchange_hack' as const, entities: ['binance'], firstSeen: 0 };
  it('matches reworded headlines about the same exchange event', () => {
    expect(sameStory('Hackers hit Binance in major security breach', 'exchange_hack', ['binance'], 60_000, ref)).toBe(true);
  });
  it('matches by word overlap', () => {
    expect(overlap(words('Binance hacked: attackers drain $400M'), words('Attackers drain $400M as Binance hacked'))).toBeGreaterThanOrEqual(0.6);
  });
  it('does not match a different exchange', () => {
    expect(sameStory('Kraken hacked in overnight exploit', 'exchange_hack', ['kraken'], 60_000, ref)).toBe(false);
  });
  it('does not match outside the window', () => {
    expect(sameStory('Hackers hit Binance again', 'exchange_hack', ['binance'], 7 * 3_600_000, ref)).toBe(false);
  });
});

describe('readMove / judgeMove', () => {
  const now = 1_000 * 60_000 * 60; // arbitrary
  function series(drop: number): PricePoint[] {
    const pts: PricePoint[] = [];
    // 24 h of a gentle wiggle around 100,000, one point a minute
    for (let m = 24 * 60; m >= 15; m--) pts.push({ t: now - m * 60_000, p: 100_000 + 80 * Math.sin(m / 7) });
    // last 15 minutes: linear move by `drop` points
    for (let m = 14; m >= 0; m--) pts.push({ t: now - m * 60_000, p: 100_000 - drop * (1 - m / 15) });
    return pts;
  }

  it('flags a 2,700-point fall in 15 minutes as abnormal', () => {
    const r = readMove(series(2700), now)!;
    expect(r.movePts).toBeLessThan(-2500);
    expect(r.ratio).toBeGreaterThan(4);
    expect(judgeMove(r, false)).toBe('unexplained');
    expect(judgeMove(r, true)).toBe('shock');
  });

  it('a normal wiggle is normal', () => {
    expect(judgeMove(readMove(series(0), now), false)).toBe('normal');
  });

  it('no history means no verdict', () => {
    expect(readMove([{ t: now, p: 1 }], now)).toBeNull();
    expect(judgeMove(null, true)).toBe('normal');
  });

  it('stale prices give no verdict', () => {
    expect(readMove(series(2700), now + 10 * 60_000)).toBeNull();
  });
});
