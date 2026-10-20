# Backend Data Gateway — Implementation Plan (Step 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every external exchange/data call through the Oracle backend so the browser only talks to its own origin, move Delta credentials + signing server-side, and harden the proxy/CORS/rate-limit — fixing the hung indicators and the security holes.

**Architecture:** One same-origin gateway endpoint `GET /api/v1/mkt?u=<encoded url>` (host+path allowlist, TTL cache, verbatim passthrough) handles all *public* exchange data. Authenticated Delta calls go through `GET /api/v1/delta/signed` which signs server-side with keys from `.env.prod`. The frontend intercepts external URLs in its existing global `fetch` wrapper (`index.html:530-561`) and rewrites them to the gateway — one choke point, no per-call-site edits. Calendar gets a cached backend route. (Dedicated news worker + unified `/ws` push + thin-client indicators are Step 2, a separate plan.)

**Tech Stack:** Fastify 5 (ESM/NodeNext), TypeScript, Drizzle, Zod, Vitest, `@fastify/rate-limit` (new). Frontend is the monolithic `frontend/index.html`.

**Spec:** `docs/superpowers/specs/2026-10-20-backend-data-gateway-design.md`

**Branch:** `feat/backend-data-gateway` (already checked out; has the `/status` fix + the spec commit).

---

## File structure

| File | Responsibility |
|---|---|
| `backend/src/lib/upstream-allowlist.ts` (new) | The single source of truth: which hosts + path prefixes may be proxied; `isAllowed(url)` |
| `backend/src/routes/mkt.ts` (new) | `GET /api/v1/mkt?u=` public passthrough gateway + in-memory TTL cache |
| `backend/src/routes/cal.ts` (new) | `GET /api/cal?week=this|next` ForexFactory calendar, hourly module cache |
| `backend/src/routes/delta.ts` (modify) | Add `GET /api/v1/delta/signed`; server-side HMAC from env; remove open `/proxy` |
| `backend/src/routes/index.ts` (modify) | Register `marketGatewayRoutes` + `calRoutes` |
| `backend/src/server.ts` (modify) | Register `@fastify/rate-limit`; mount `/api/cal`; remove `/api/delta-proxy` |
| `backend/src/lib/*.test.ts`, `routes/*.test.ts` (new) | Vitest for allowlist, cache, signing |
| `frontend/index.html` (modify) | Gateway rewrite in the `fetch` wrapper (~L556); rewire `dget` (~L18100); delete client signing/keys |
| `docs/OPERATIONS_HANDOFF.md` (new) | LLM/SSH ops handoff |

---

## Task 1: Add rate-limiting dependency + register it

**Files:**
- Modify: `backend/package.json` (dependencies)
- Modify: `backend/src/server.ts` (register plugin, after CORS ~line 39)

- [ ] **Step 1: Add the dependency**

Run in `backend/`:
```bash
npm install @fastify/rate-limit@^10.1.1
```
Expected: `package.json` gains `"@fastify/rate-limit": "^10.1.1"` and it installs cleanly.

- [ ] **Step 2: Register it globally in `server.ts`**

Add the import near the other plugin imports (top of `backend/src/server.ts`):
```typescript
import rateLimit from '@fastify/rate-limit';
```
Immediately AFTER the existing CORS `await app.register(cors, {...})` block (currently `server.ts:36-39`), add:
```typescript
await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX) || 600, // requests
  timeWindow: process.env.RATE_LIMIT_WINDOW || '1 minute',
  allowList: ['127.0.0.1'], // Caddy/health checks on the local docker network
});
```

- [ ] **Step 3: Verify build**

Run: `cd backend && npm run build`
Expected: compiles, no type errors.

- [ ] **Step 4: Commit**
```bash
git add backend/package.json backend/package-lock.json backend/src/server.ts
git commit -m "feat(backend): add @fastify/rate-limit, register globally"
```

---

## Task 2: Upstream allowlist (single source of truth)

**Files:**
- Create: `backend/src/lib/upstream-allowlist.ts`
- Test: `backend/src/lib/upstream-allowlist.test.ts`

- [ ] **Step 1: Write the failing test**

`backend/src/lib/upstream-allowlist.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { isAllowed } from './upstream-allowlist.js';

describe('isAllowed', () => {
  it('allows listed Delta public paths', () => {
    expect(isAllowed('https://api.india.delta.exchange/v2/tickers/BTCUSD')).toBe(true);
    expect(isAllowed('https://api.india.delta.exchange/v2/l2orderbook/BTCUSD?depth=20')).toBe(true);
  });
  it('allows Deribit, Binance, OKX and news hosts', () => {
    expect(isAllowed('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC')).toBe(true);
    expect(isAllowed('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m')).toBe(true);
    expect(isAllowed('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP')).toBe(true);
    expect(isAllowed('https://api.llama.fi/hacks')).toBe(true);
  });
  it('rejects unknown hosts and non-https', () => {
    expect(isAllowed('https://evil.example.com/v2/tickers')).toBe(false);
    expect(isAllowed('http://api.india.delta.exchange/v2/tickers')).toBe(false);
    expect(isAllowed('https://api.india.delta.exchange/v2/wallet/balances')).toBe(false); // account path not public
    expect(isAllowed('not a url')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd backend && npx vitest run src/lib/upstream-allowlist.test.ts`
Expected: FAIL — `isAllowed` not found.

- [ ] **Step 3: Implement**

`backend/src/lib/upstream-allowlist.ts`:
```typescript
/**
 * The ONLY hosts + path prefixes the public market gateway (/api/v1/mkt) may fetch.
 * Keeps the proxy from being an open relay (SSRF). Account/private Delta paths are
 * intentionally excluded — those go through /api/v1/delta/signed instead.
 */
interface Rule { host: string; prefixes: string[] }

const RULES: Rule[] = [
  { host: 'api.india.delta.exchange', prefixes: ['/v2/products', '/v2/tickers', '/v2/history/candles', '/v2/l2orderbook/', '/v2/trades/'] },
  { host: 'www.deribit.com', prefixes: ['/api/v2/public/'] },
  { host: 'fapi.binance.com', prefixes: ['/fapi/'] },
  { host: 'api.binance.com', prefixes: ['/api/v3/'] },
  { host: 'data-api.binance.vision', prefixes: ['/api/v3/'] },
  { host: 'data.binance.vision', prefixes: ['/data/'] },
  { host: 'www.okx.com', prefixes: ['/api/v5/public/'] },
  { host: 'cryptocurrency.cv', prefixes: ['/api/'] },
  { host: 'api.llama.fi', prefixes: ['/hacks'] },
];

export function isAllowed(rawUrl: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const rule = RULES.find((r) => r.host === u.hostname);
  if (!rule) return false;
  return rule.prefixes.some((p) => u.pathname.startsWith(p));
}

export const ALLOWED_HOSTS = RULES.map((r) => r.host);
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd backend && npx vitest run src/lib/upstream-allowlist.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**
```bash
git add backend/src/lib/upstream-allowlist.ts backend/src/lib/upstream-allowlist.test.ts
git commit -m "feat(backend): upstream host+path allowlist for the market gateway"
```

---

## Task 3: Market gateway `/api/v1/mkt` with TTL cache

**Files:**
- Create: `backend/src/routes/mkt.ts`
- Test: `backend/src/routes/mkt.test.ts`
- Modify: `backend/src/routes/index.ts`

- [ ] **Step 1: Write the failing test**

`backend/src/routes/mkt.test.ts` (tests allowlist enforcement + that a disallowed host is rejected without any network call):
```typescript
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { marketGatewayRoutes } from './mkt.js';

async function build() {
  const app = Fastify();
  await app.register(marketGatewayRoutes, { prefix: '/api/v1/mkt' });
  return app;
}

describe('GET /api/v1/mkt', () => {
  it('400s when u is missing', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/mkt' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it('403s a disallowed host', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/v1/mkt?u=' + encodeURIComponent('https://evil.example.com/x') });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd backend && npx vitest run src/routes/mkt.test.ts`
Expected: FAIL — `marketGatewayRoutes` not found.

- [ ] **Step 3: Implement**

`backend/src/routes/mkt.ts`:
```typescript
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

export const marketGatewayRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request, reply) => {
    const u = (request.query as { u?: string }).u;
    if (!u || typeof u !== 'string') {
      return reply.status(400).send({ success: false, error: 'Missing ?u= target url' });
    }
    if (!isAllowed(u)) {
      return reply.status(403).send({ success: false, error: 'Target not in allowlist' });
    }

    const now = Date.now();
    const hit = cache.get(u);
    if (hit && now - hit.at < ttlFor(u)) {
      return reply.status(hit.status).type(hit.contentType).send(hit.body);
    }

    try {
      const upstream = await fetch(u, {
        headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
        signal: AbortSignal.timeout(12_000),
      });
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      const body = Buffer.from(await upstream.arrayBuffer());
      cache.set(u, { at: now, status: upstream.status, contentType, body });
      // bound the cache
      if (cache.size > 500) { const first = cache.keys().next().value; if (first) cache.delete(first); }
      return reply.status(upstream.status).type(contentType).send(body);
    } catch (err: any) {
      if (hit) return reply.status(hit.status).type(hit.contentType).send(hit.body); // serve stale on upstream failure
      return reply.status(502).send({ success: false, error: `Upstream fetch failed: ${err?.message || 'timeout'}` });
    }
  });
};
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd backend && npx vitest run src/routes/mkt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the route**

In `backend/src/routes/index.ts`, add the import with the others:
```typescript
import { marketGatewayRoutes } from './mkt.js';
```
and register it inside `apiV1Routes` (alongside the existing `fastify.register(marketRoutes, ...)`):
```typescript
  await fastify.register(marketGatewayRoutes, { prefix: '/mkt' });
```

- [ ] **Step 6: Build + commit**

Run: `cd backend && npm run build` → expected: clean.
```bash
git add backend/src/routes/mkt.ts backend/src/routes/mkt.test.ts backend/src/routes/index.ts
git commit -m "feat(backend): /api/v1/mkt public market gateway with allowlist + TTL cache"
```

---

## Task 4: Server-side Delta signing `/api/v1/delta/signed`

**Files:**
- Modify: `backend/src/routes/delta.ts`
- Modify: `backend/src/server.ts` (remove the open `/api/delta-proxy` compat routes)
- Test: `backend/src/routes/delta-sign.test.ts`

- [ ] **Step 1: Write the failing test (signature correctness)**

`backend/src/routes/delta-sign.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { signDelta } from './delta.js';

describe('signDelta', () => {
  it('matches the Delta HMAC scheme (GET + ts + path + query)', () => {
    const secret = 'testsecret';
    const ts = '1700000000';
    const path = '/v2/wallet/balances';
    const query = '';
    const expected = crypto.createHmac('sha256', secret).update('GET' + ts + path + query).digest('hex');
    expect(signDelta(secret, 'GET', ts, path, query)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd backend && npx vitest run src/routes/delta-sign.test.ts`
Expected: FAIL — `signDelta` not exported.

- [ ] **Step 3: Implement signing + signed route in `delta.ts`**

Add near the top of `backend/src/routes/delta.ts` (after `const DELTA_BASE`):
```typescript
import crypto from 'node:crypto';

export function signDelta(secret: string, method: string, ts: string, path: string, query: string): string {
  return crypto.createHmac('sha256', secret).update(method + ts + path + query).digest('hex');
}
```

Inside `export const deltaRoutes` (after the existing `/status` handler, before the closing `};`), add:
```typescript
  // Server-side signed relay for authenticated Delta calls (key+secret from env, never the browser).
  fastify.get('/signed', async (request, reply) => {
    const q = (request.query || {}) as { path?: string; query?: string };
    const path = q.path;
    const query = q.query || '';
    if (!path || !path.startsWith('/v2/')) {
      return reply.status(400).send({ success: false, error: 'path must start with /v2/' });
    }
    const key = process.env.DELTA_API_KEY;
    const secret = process.env.DELTA_API_SECRET;
    if (!key || !secret) {
      return reply.status(503).send({ success: false, error: 'Delta credentials not configured on server' });
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const q = query ? '?' + query.replace(/^\?/, '') : ''; // client signs with the '?'-prefixed query
    const sig = signDelta(secret, 'GET', ts, path, q);
    try {
      const upstream = await fetch(`${DELTA_BASE}${path}${q}`, {
        headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
        signal: AbortSignal.timeout(12_000),
      });
      const data = await upstream.json().catch(() => null);
      return reply.status(upstream.status).send(data ?? { success: false, error: 'Empty upstream response' });
    } catch (err: any) {
      return reply.status(502).send({ success: false, error: `Failed to reach Delta: ${err?.message || 'timeout'}` });
    }
  });
```
> Note: the signed message uses the query string exactly as the old client did (`'GET'+ts+path+q` where `q` is `?...` or ``). Keep `query` as passed by the client (already `?`-prefixed form handled above).

Remove the open client-signed proxy: delete `fastify.get('/proxy', handleDeltaProxy);` and `fastify.post('/proxy', handleDeltaProxy);` from `deltaRoutes`, and delete the `handleDeltaProxy` function (lines 63-115). Keep `/ip` and `/status`.

- [ ] **Step 4: Remove the `/api/delta-proxy` compat routes in `server.ts`**

In `backend/src/server.ts`, delete these two lines (currently ~67-68):
```typescript
app.get('/api/delta-proxy', handleDeltaProxy);
app.post('/api/delta-proxy', handleDeltaProxy);
```
and remove the now-unused `handleDeltaProxy` import.

- [ ] **Step 5: Run signing test + build**

Run: `cd backend && npx vitest run src/routes/delta-sign.test.ts` → PASS.
Run: `cd backend && npm run build` → clean (fixes any dangling `handleDeltaProxy` references).

- [ ] **Step 6: Commit**
```bash
git add backend/src/routes/delta.ts backend/src/routes/delta-sign.test.ts backend/src/server.ts
git commit -m "feat(backend): server-side Delta signing /api/v1/delta/signed; drop open proxy"
```

---

## Task 5: Calendar route `/api/cal` (replaces the dead Vercel function)

**Files:**
- Create: `backend/src/routes/cal.ts`
- Modify: `backend/src/server.ts` (mount at root `/api/cal`, matching the frontend's existing call)
- Test: `backend/src/routes/cal.test.ts`

- [ ] **Step 1: Write the failing test**

`backend/src/routes/cal.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { calRoutes } from './cal.js';

describe('GET /api/cal', () => {
  it('rejects a bad week param', async () => {
    const app = Fastify();
    await app.register(calRoutes);
    const res = await app.inject({ method: 'GET', url: '/api/cal?week=lastyear' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd backend && npx vitest run src/routes/cal.test.ts`
Expected: FAIL — `calRoutes` not found.

- [ ] **Step 3: Implement**

`backend/src/routes/cal.ts`:
```typescript
import type { FastifyPluginAsync } from 'fastify';

/**
 * Economic calendar relay (replaces the old Vercel /api/cal function).
 * Fetches ForexFactory's free weekly JSON from the server and caches it for 1h.
 */
const FF = {
  this: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  next: 'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
};
const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 60 * 60 * 1000;

export const calRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/cal', async (request, reply) => {
    const week = (request.query as { week?: string }).week;
    if (week !== 'this' && week !== 'next') {
      return reply.status(400).send({ success: false, error: 'week must be "this" or "next"' });
    }
    const now = Date.now();
    const hit = cache.get(week);
    if (hit && now - hit.at < TTL) return reply.send(hit.data);
    try {
      const res = await fetch(FF[week], { headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.timeout(12_000) });
      const data = await res.json();
      cache.set(week, { at: now, data });
      return reply.send(data);
    } catch (err: any) {
      if (hit) return reply.send(hit.data);
      return reply.status(502).send({ success: false, error: `Calendar fetch failed: ${err?.message || 'timeout'}` });
    }
  });
};
```

- [ ] **Step 4: Run it, confirm it passes**

Run: `cd backend && npx vitest run src/routes/cal.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount it in `server.ts`**

In `backend/src/server.ts`, near where `apiV1Routes` is registered, add:
```typescript
import { calRoutes } from './routes/cal.js';
// ...
await app.register(calRoutes);
```
(No prefix — the route declares the full `/api/cal` path so it matches the frontend's existing call.)

- [ ] **Step 6: Build + commit**

Run: `cd backend && npm run build` → clean.
```bash
git add backend/src/routes/cal.ts backend/src/routes/cal.test.ts backend/src/server.ts
git commit -m "feat(backend): /api/cal calendar relay (replaces dead Vercel function)"
```

---

## Task 6: Frontend — rewrite external calls through the gateway (one choke point)

**Files:**
- Modify: `frontend/index.html` — the global `fetch` wrapper (currently `index.html:555-560`).

The wrapper already replaces `W.fetch`. We add a URL-rewrite at its top so *every* fetch to an allowlisted exchange host is redirected to `/api/v1/mkt?u=...` (same-origin). Public market data (all the hung indicators, Deribit, Binance, OKX, news feeds) is fixed by this single change.

- [ ] **Step 1: Add the rewrite helper + apply it in the wrapper**

Find (`index.html:555-556`):
```javascript
if(F)W.fetch=function(input,init){var u=typeof input==='string'?input:(input&&input.url)||'';
  if(!u||(init&&init.method&&init.method!=='GET')||!isLow(u))return F(input,init);
```
Replace those two lines with:
```javascript
var GW_HOSTS={'api.india.delta.exchange':['/v2/products','/v2/tickers','/v2/history/candles','/v2/l2orderbook/','/v2/trades/'],'www.deribit.com':['/api/v2/public/'],'fapi.binance.com':['/fapi/'],'api.binance.com':['/api/v3/'],'data-api.binance.vision':['/api/v3/'],'data.binance.vision':['/data/'],'www.okx.com':['/api/v5/public/'],'cryptocurrency.cv':['/api/'],'api.llama.fi':['/hacks']};
function gwRewrite(u){try{var p=new URL(u,location.href);var ps=GW_HOSTS[p.hostname];if(ps&&ps.some(function(x){return p.pathname.indexOf(x)===0;}))return '/api/v1/mkt?u='+encodeURIComponent(p.href);}catch(e){}return u;}
if(F)W.fetch=function(input,init){var u0=typeof input==='string'?input:(input&&input.url)||'';
  var rw=gwRewrite(u0); if(rw!==u0){input=rw;} var u=rw;
  if(!u||(init&&init.method&&init.method!=='GET')||!isLow(u))return F(input,init);
```
This keeps the existing slow-lane logic intact (it now sees the rewritten same-origin URL).

- [ ] **Step 2: Build the frontend**

Run: `cd frontend && npm run build`
Expected: `vite build` succeeds, `dist/` produced.

- [ ] **Step 3: Manual verification against the backend (local)**

Start the backend locally (`cd backend && npm run dev`), open `frontend/dist/index.html` served by it, and in DevTools confirm requests go to `/api/v1/mkt?u=...` (same-origin) — not to `deribit.com`/`delta.exchange`. (Full live verification is Task 9.)

- [ ] **Step 4: Commit**
```bash
git add frontend/index.html
git commit -m "feat(frontend): route public exchange calls through same-origin /api/v1/mkt gateway"
```

---

## Task 7: Frontend — move Delta signing server-side (rewire `dget`, delete browser keys)

**Files:**
- Modify: `frontend/index.html` — the `dget` + credential block (`index.html:18093-18113`).

- [ ] **Step 1: Replace the credential/signing block**

Replace `index.html:18096-18113` (the `const DELTA=...` through the end of `dget`) with:
```javascript
const DELTA='https://api.india.delta.exchange';
// Credentials + signing now live on the server (.env.prod). The browser calls the same-origin
// signed relay; it holds no key or secret.
const API={key:()=>null,on:()=>true,at:0,err:null,busy:false,last:null,route:'server',tried:0};
async function dget(path,query){
  const q=query?('?'+query):'';
  const u='/api/v1/delta/signed?path='+encodeURIComponent(path)+'&query='+encodeURIComponent(query||'');
  const r=await fetch(u,{headers:{Accept:'application/json'},cache:'no-store'});
  const j=await r.json().catch(()=>null);
  if(!r.ok||!j||j.success===false){const c=j&&j.error?(j.error.code||j.error.message||JSON.stringify(j.error)):'HTTP '+r.status;const er=new Error(String(c));er.detail=j&&j.error||null;er.status=r.status;throw er;}
  dget.meta=j.meta||null;return j.result;
}
```
This deletes `hmacHex`, `proxyUrl`, the `v100_dkey`/`v100_droute`/`v100_dproxy` usage, and the direct/proxy fallback — `dget` now just calls the server, which signs.

- [ ] **Step 2: Remove any leftover key-entry UI writes**

Search `index.html` for `v100_dkey` and `v100_droute`; remove the code paths that *set* them (the API-key entry form handlers). If a settings panel reads `API.on()`, it now returns `true` (server holds the key) — leave read sites alone unless they error.
Run: `grep -n "v100_dkey\|v100_droute\|v100_dproxy\|hmacHex" frontend/index.html` → expected: no remaining references after cleanup.

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build` → expected: succeeds.

- [ ] **Step 4: Commit**
```bash
git add frontend/index.html
git commit -m "feat(frontend): Delta signing moves server-side; remove browser key/secret + client HMAC"
```

---

## Task 8: Operations handoff doc for LLMs/SSH

**Files:**
- Create: `docs/OPERATIONS_HANDOFF.md`

- [ ] **Step 1: Write the doc** with the concrete live details:
  - SSH: `ssh -i ~/.ssh/oracle_key ubuntu@92.4.74.5` (user `ubuntu`, key on the operator's machine).
  - Host/domain: `92.4.74.5` (reserved) / `https://suraj-voldesk.duckdns.org`.
  - App dir `~/app`; stack files `docker-compose.prod.yml` (build on VM) and `docker-compose.ghcr.yml` (pull image); `Caddyfile`; secrets in `~/app/.env` (DOMAIN) + `~/app/.env.prod` (`DATABASE_URL`, `DELTA_API_KEY`, `DELTA_API_SECRET`, `CORS_ORIGINS`, alerts).
  - Commands: launch (`docker compose -f docker-compose.prod.yml up -d --build`), logs (`... logs --tail 200 app`), restart, redeploy (`VM_IP=92.4.74.5 ./deploy.sh`), health (`curl .../health`, `.../api/v1/delta/ip`, `.../api/v1/delta/status`).
  - Architecture pointer: browser talks only to same-origin; backend proxies exchanges via `/api/v1/mkt` + `/api/v1/delta/signed`; Postgres is Neon (external). Link `DEPLOY_ORACLE.md` and this plan's spec.
  - "Current state" section (date-stamped) describing what is deployed.

- [ ] **Step 2: Commit**
```bash
git add docs/OPERATIONS_HANDOFF.md
git commit -m "docs: operations handoff (SSH + deploy specifics) for LLM/human operators"
```

---

## Task 9: Deploy to Oracle + live smoke-test

**Files:** none (ops). Prereq: user places `DELTA_API_KEY` + `DELTA_API_SECRET` in `~/app/.env.prod`.

- [ ] **Step 1: Set secrets + CORS on the VM** (user, over SSH):
```bash
cd ~/app
# append to .env.prod:  DELTA_API_KEY=...  DELTA_API_SECRET=...  CORS_ORIGINS=https://suraj-voldesk.duckdns.org
nano .env.prod && chmod 600 .env.prod
```

- [ ] **Step 2: Ship + rebuild** (operator, from repo root after merge to `main`):
```bash
VM_IP=92.4.74.5 ./deploy.sh
```

- [ ] **Step 3: Backend smoke-test** (operator):
```bash
curl -sS "https://suraj-voldesk.duckdns.org/api/v1/mkt?u=$(python -c 'import urllib.parse;print(urllib.parse.quote("https://api.india.delta.exchange/v2/tickers/BTCUSD"))')" | head -c 200
curl -sS "https://suraj-voldesk.duckdns.org/api/cal?week=this" | head -c 120
curl -sS "https://suraj-voldesk.duckdns.org/api/v1/delta/signed?path=%2Fv2%2Fwallet%2Fbalances" | head -c 200
```
Expected: ticker JSON; calendar JSON; signed call returns account JSON (not a 503/credentials error).

- [ ] **Step 4: Browser smoke-test (Chrome DevTools MCP):** load the site; assert **zero** network requests to exchange hosts (all to `suraj-voldesk.duckdns.org`), indicators populate, no console errors.

- [ ] **Step 5: Commit nothing; record result** in `docs/OPERATIONS_HANDOFF.md` "Current state".

---

## Verification (end-to-end)

1. `cd backend && npm run test` → all vitest green (allowlist, mkt 400/403, signing, cal 400).
2. `cd backend && npm run build` and `cd frontend && npm run build` → both clean.
3. Live: the Task 9 curls succeed; browser shows no exchange-host requests and indicators fill.
4. `grep -n "deribit.com\|india.delta.exchange" frontend/index.html` still shows the constants (they're rewritten at fetch time, not removed) — but DevTools shows no outbound calls to them.

## Self-review notes (gaps intentionally deferred to Step 2)
- Dedicated news worker + unified `/ws` push + thin-client indicator consumption → **Step 2 plan** (the `@fastify/websocket` plugin is already registered but unused; `/ws` routes come then).
- Breaking up `index.html` → out of scope.
