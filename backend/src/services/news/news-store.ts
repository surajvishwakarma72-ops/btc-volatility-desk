import { pool } from '../../db/index.js';
import type { NewsEvent, NewsStore } from './news-watcher.js';

let ready: Promise<void> | null = null;

export async function ensureNewsSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS news_events (
          id uuid PRIMARY KEY,
          kind varchar(10) NOT NULL,
          severity varchar(10) NOT NULL,
          category varchar(20) NOT NULL,
          reason text NOT NULL,
          title text NOT NULL,
          link text,
          entities jsonb NOT NULL DEFAULT '[]',
          sources jsonb NOT NULL DEFAULT '[]',
          first_seen timestamptz NOT NULL,
          published_at timestamptz,
          move jsonb,
          alerted_at timestamptz,
          acked_at timestamptz,
          linked_id uuid
        );
        CREATE INDEX IF NOT EXISTS idx_news_events_first_seen ON news_events(first_seen DESC);
      `);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function toRow(e: NewsEvent): unknown[] {
  return [
    e.id, e.kind, e.severity, e.category, e.reason, e.title, e.link || null, JSON.stringify(e.entities), JSON.stringify(e.sources),
    new Date(e.firstSeen), e.publishedAt ? new Date(e.publishedAt) : null, e.move ? JSON.stringify(e.move) : null,
    e.alertedAt ? new Date(e.alertedAt) : null, e.ackedAt ? new Date(e.ackedAt) : null, e.linkedId || null,
  ];
}

const ms = (v: unknown): number | null => (v ? new Date(v as string).getTime() : null);
const json = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

function fromRow(r: any): NewsEvent {
  return {
    id: r.id, kind: r.kind, severity: r.severity, category: r.category, reason: r.reason, title: r.title, link: r.link || '',
    entities: json(r.entities, []), sources: json(r.sources, []), firstSeen: ms(r.first_seen)!, publishedAt: ms(r.published_at),
    move: json(r.move, null), alertedAt: ms(r.alerted_at), ackedAt: ms(r.acked_at), linkedId: r.linked_id || null,
  };
}

export const pgNewsStore: NewsStore = {
  async load(sinceMs) {
    await ensureNewsSchema();
    const r = await pool.query('SELECT * FROM news_events WHERE first_seen >= $1 ORDER BY first_seen DESC LIMIT 2000', [new Date(sinceMs)]);
    return r.rows.map(fromRow);
  },
  async save(e) {
    await ensureNewsSchema();
    await pool.query(
      `INSERT INTO news_events (id, kind, severity, category, reason, title, link, entities, sources, first_seen, published_at, move, alerted_at, acked_at, linked_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET severity = EXCLUDED.severity, category = EXCLUDED.category, reason = EXCLUDED.reason,
         sources = EXCLUDED.sources, move = EXCLUDED.move, alerted_at = EXCLUDED.alerted_at, acked_at = EXCLUDED.acked_at,
         linked_id = EXCLUDED.linked_id`,
      toRow(e),
    );
  },
};
