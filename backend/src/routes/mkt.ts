import type { FastifyPluginAsync } from 'fastify';
import { isAllowed } from '../lib/upstream-allowlist.js';

/**
 * Public market-data gateway. GET /api/v1/mkt?u=<encoded absolute https url>.
 * Validates the URL against the allowlist, fetches it from the server's
 * whitelisted IP, caches briefly, and returns the upstream body verbatim.
 */
interface CacheEntry { at: number; status: number; contentType: string; body: Buffer }
const cache = new Map<string, CacheEntry>();

function ttlFor(url: string): number {
  if (url.includes('/history/candles') || url.includes('get_volatility_index_data') || url.includes('/klines') || url.includes('.zip')) return 30_000;
  return 2_000; // quotes / orderbook / tickers
}

/**
 * Binance's public archive (data.binance.vision) throttles bursts from a shared cloud IP (HTTP 429) but answers a
 * patient one-at-a-time client. Its daily files never change, so they are fetched through ONE queue (spaced, with
 * backoff on 429) and kept for a week; the desk's multi-year futures history then loads from here without a storm.
 */
interface ArchiveHit { at: number; status: number; contentType: string; body: Buffer }
const archive = new Map<string, ArchiveHit>();
const archiveInflight = new Map<string, Promise<ArchiveHit>>();
let archiveChain: Promise<unknown> = Promise.resolve();
const ARCHIVE_TTL_OK = 7 * 24 * 3600_000;
const ARCHIVE_TTL_404 = 3600_000;
const ARCHIVE_MAX_BODY = 256 * 1024;        // a daily metrics zip is ~12 KB
const ARCHIVE_MAX_BYTES = 40 * 1024 * 1024; // total cache budget
const ARCHIVE_MAX_QUEUE = 300;              // pending upstream jobs; beyond this the gateway answers 503
const ARCHIVE_WAIT_MS = 60_000;             // longest a caller waits in the queue
let archiveBytes = 0, archiveQueued = 0;
/** Only the one file family the desk needs, with a real date: https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-YYYY-MM-DD.zip (no query, no fragment). Returns the canonical URL or null. */
const ARCHIVE_RE = /^\/data\/futures\/um\/daily\/metrics\/BTCUSDT\/BTCUSDT-metrics-(\d{4})-(\d{2})-(\d{2})\.zip$/;
function archiveKey(u: string): string | null {
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' || p.hostname !== 'data.binance.vision' || p.port || p.username || p.password || p.search || p.hash) return null;
    const m = ARCHIVE_RE.exec(p.pathname); if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (!(t >= Date.UTC(2020, 0, 1) && t <= Date.now()) || new Date(t).getUTCDate() !== +m[3]) return null;   // a real, past date
    return `https://data.binance.vision${p.pathname}`;
  } catch { return null; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchArchive(u: string): Promise<ArchiveHit> {
  const hit = archive.get(u);
  if (hit && Date.now() - hit.at < (hit.status === 200 ? ARCHIVE_TTL_OK : ARCHIVE_TTL_404)) return hit;
  const running = archiveInflight.get(u);
  if (running) return running;
  if (archiveQueued >= ARCHIVE_MAX_QUEUE) return { at: Date.now(), status: 503, contentType: 'application/octet-stream', body: Buffer.alloc(0) };
  archiveQueued++;
  const job = new Promise<ArchiveHit>((resolve) => {
    archiveChain = archiveChain.then(async () => {
      try {
      let last: ArchiveHit = { at: Date.now(), status: 502, contentType: 'application/json', body: Buffer.from('{"success":false,"error":"archive unavailable"}') };
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.timeout(15_000) });
          if (r.status >= 300 && r.status < 400) { last = { at: Date.now(), status: 502, contentType: 'application/octet-stream', body: Buffer.alloc(0) }; break; }   // never follow a redirect off the allowlisted file
          if (Number(r.headers.get('content-length') || 0) > ARCHIVE_MAX_BODY) { last = { at: Date.now(), status: 502, contentType: 'application/octet-stream', body: Buffer.alloc(0) }; break; }
          const body = Buffer.from(await r.arrayBuffer()); if (body.length > ARCHIVE_MAX_BODY) { last = { at: Date.now(), status: 502, contentType: 'application/octet-stream', body: Buffer.alloc(0) }; break; }
          if (r.status === 200 || r.status === 404) {
            last = { at: Date.now(), status: r.status, contentType: r.status === 200 ? 'application/zip' : 'application/octet-stream', body: r.status === 200 ? body : Buffer.alloc(0) };
            break;
          }
          last = { at: Date.now(), status: r.status === 429 ? 429 : 502, contentType: 'application/octet-stream', body: Buffer.alloc(0) };
          if (r.status === 429 || r.status >= 500) { await sleep(Math.min(8000, 1500 * 2 ** attempt)); continue; }
          break;
        } catch { await sleep(1000 * (attempt + 1)); }
      }
      if (last.status === 200 || last.status === 404) {
        const old = archive.get(u); if (old) archiveBytes -= old.body.length;
        archive.set(u, last); archiveBytes += last.body.length;
        while ((archiveBytes > ARCHIVE_MAX_BYTES || archive.size > 2500) && archive.size) { const first = archive.keys().next().value as string; const v = archive.get(first); if (v) archiveBytes -= v.body.length; archive.delete(first); }
      }
      await sleep(350);   // spacing between archive requests
      resolve(last);
      } finally { archiveQueued--; }
    });
  });
  archiveInflight.set(u, job);
  const timeout = new Promise<ArchiveHit>((resolve) => setTimeout(() => resolve({ at: Date.now(), status: 503, contentType: 'application/octet-stream', body: Buffer.alloc(0) }), ARCHIVE_WAIT_MS));
  try { return await Promise.race([job, timeout]); } finally { archiveInflight.delete(u); }
}

export const marketGatewayRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const u = (request.query as { u?: string }).u;
    if (!u || typeof u !== 'string') {
      return reply.status(400).send({ success: false, error: 'Missing ?u= target url' });
    }
    if (!isAllowed(u)) {
      return reply.status(403).send({ success: false, error: 'Target not in allowlist' });
    }

    const ak = archiveKey(u);
    if (ak) {
      const a = await fetchArchive(ak);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', a.status === 200 ? 'public, max-age=86400' : 'no-store');
      return reply.status(a.status).type(a.contentType).send(a.body);
    }

    const now = Date.now();
    const hit = cache.get(u);
    if (hit && now - hit.at < ttlFor(u)) {
      return reply.status(hit.status).type(hit.contentType).send(hit.body);
    }

    try {
      // Follow redirects MANUALLY, re-validating each hop against the allowlist so an
      // allowlisted host cannot 3xx us to an internal/metadata URL (SSRF-via-redirect).
      let target = u;
      let upstream: Awaited<ReturnType<typeof fetch>> | null = null;
      for (let hop = 0; hop < 4; hop++) {
        if (!isAllowed(target)) {
          return reply.status(403).send({ success: false, error: 'Redirect target not in allowlist' });
        }
        upstream = await fetch(target, {
          redirect: 'manual',
          headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
          signal: AbortSignal.timeout(12_000),
        });
        if (upstream.status >= 300 && upstream.status < 400) {
          const loc = upstream.headers.get('location');
          if (!loc) break;
          target = new URL(loc, target).toString();
          continue;
        }
        break;
      }
      if (!upstream) return reply.status(502).send({ success: false, error: 'No upstream response' });

      // Serve only a safe content-type set from our own origin; coerce anything else to
      // octet-stream and forbid MIME sniffing so a hostile upstream cannot XSS us.
      const SAFE = new Set(['application/json', 'text/csv', 'application/octet-stream', 'application/zip']);
      const rawCt = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const contentType = SAFE.has(rawCt) ? rawCt : 'application/octet-stream';
      const body = Buffer.from(await upstream.arrayBuffer());
      // Only cache successful responses — caching a 429/503 would poison the TTL window.
      if (upstream.ok) {
        cache.set(u, { at: Date.now(), status: upstream.status, contentType, body });
        if (cache.size > 300) {
          const cut = Date.now() - 60_000;
          for (const [k, v] of cache.entries()) {
            if (v.at < cut) cache.delete(k);
          }
          if (cache.size > 500) {
            const first = cache.keys().next().value;
            if (first) cache.delete(first);
          }
        }
      }
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.status(upstream.status).type(contentType).send(body);
    } catch (err: any) {
      if (hit) { reply.header('X-Content-Type-Options', 'nosniff'); return reply.status(hit.status).type(hit.contentType).send(hit.body); }
      return reply.status(502).send({ success: false, error: `Upstream fetch failed: ${err?.message || 'timeout'}` });
    }
  });
};
