/**
 * Minimal RSS 2.0 / Atom reader (no dependency). Returns title, link, time and summary per item.
 * Google News titles end in " - Source"; that suffix becomes the item's source.
 */

export interface FeedItem {
  title: string;
  link: string;
  /** UTC ms; null when the item carries no readable date. */
  publishedAt: number | null;
  summary: string;
  /** Publisher named inside the item (Google News), else ''. */
  source: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function text(raw: string | undefined): string {
  if (!raw) return '';
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(unwrapped.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : undefined;
}

function atomLink(block: string): string {
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return alt ? decodeEntities(alt[1]) : '';
}

/** Only http(s) links survive; a feed must not be able to plant a javascript: or data: link in the popup. */
export function safeLink(u: string): string {
  try { const p = new URL(String(u || '').trim()); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : ''; } catch { return ''; }
}

function when(s: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function parseFeed(xml: string): FeedItem[] {
  const src = String(xml || '');
  const blocks = src.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? src.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  const out: FeedItem[] = [];
  for (const b of blocks) {
    let title = text(tag(b, 'title'));
    if (!title) continue;
    let source = text(tag(b, 'source'));
    const link = safeLink(text(tag(b, 'link')) || atomLink(b));
    const publishedAt = when(text(tag(b, 'pubDate')) || text(tag(b, 'published')) || text(tag(b, 'updated')) || text(tag(b, 'dc:date')));
    const summary = text(tag(b, 'description') || tag(b, 'summary') || '').slice(0, 400);
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    else if (!source) source = '';
    out.push({ title, link, publishedAt, summary, source });
  }
  return out;
}
