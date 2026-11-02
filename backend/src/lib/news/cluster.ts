/**
 * Same story from many sources → one event. Two headlines are the same story when their meaningful words overlap
 * enough, or when they share the same category and the same named exchange/stablecoin within the window.
 */
import type { Category } from './classify.js';

const STOP = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'as', 'at', 'by', 'with', 'from', 'after', 'amid', 'over',
  'is', 'are', 'was', 'were', 'be', 'has', 'have', 'had', 'its', 'it', 'this', 'that', 'says', 'said', 'report', 'reports',
  'reportedly', 'news', 'breaking', 'update', 'live', 'just', 'now', 'new', 'more', 'than', 'into', 'up', 'down', 'out',
  'crypto', 'bitcoin', 'btc', 'market', 'markets', 'price', 'what', 'why', 'how', 'who', 'will', 'could', 'may',
]);

export function words(title: string): Set<string> {
  const toks = String(title || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9.$]+/).map((w) => w.replace(/^\.+|\.+$/g, ''));
  return new Set(toks.filter((w) => w.length > 2 && !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w)));
}

export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

export interface StoryRef {
  title: string;
  category: Category;
  entities: string[];
  firstSeen: number;
}

const NAMED = /^(binance|coinbase|deribit|okx|bybit|kraken|bitfinex|bitstamp|kucoin|gate\.io|htx|huobi|bitget|mexc|gemini|crypto\.com|upbit|bithumb|delta exchange|wazirx|coindcx|robinhood|bitmex|usdt|tether|usdc|circle|dai|usde|ethena|fdusd|pyusd|tusd)$/;

/** True when `title` tells the same story as `ref` (within `windowMs` of ref's first sighting). */
export function sameStory(title: string, category: Category, entities: string[], at: number, ref: StoryRef, windowMs = 6 * 3_600_000): boolean {
  if (Math.abs(at - ref.firstSeen) > windowMs) return false;
  if (overlap(words(title), words(ref.title)) >= 0.6) return true;
  if (category === 'general' || category === 'macro' || category !== ref.category) return false;
  const named = entities.filter((e) => NAMED.test(e));
  return named.length > 0 && named.some((e) => ref.entities.includes(e));
}

/** Stable key for storage; the first headline of the story. */
export function storyKey(title: string): string {
  return [...words(title)].sort().join(' ').slice(0, 200);
}
