# Backend Data Gateway — Issues & Solutions (Design Spec)

**Date:** 2026-10-20
**Status:** Draft for review (brainstorming output → feeds the implementation plan)
**Scope:** Route ALL external exchange/data calls through the Oracle backend; remove
browser↔exchange traffic; move Delta credentials + signing server-side; harden security.

---

## Context

The desk now runs on an Oracle VM (`92.4.74.5`, `https://suraj-voldesk.duckdns.org`). The
dashboard **chat loads but indicators never load**. Diagnosis: the frontend (`frontend/index.html`,
~27k lines) calls exchange APIs **directly from the browser**. The Oracle backend reaches those
APIs fine (verified HTTP 200 to Delta/Deribit), and the exchanges return permissive CORS
(`access-control-allow-origin: *` / reflected origin) — so it is **not a CORS problem**. The
browser's calls to `api.india.delta.exchange` / `www.deribit.com` simply **hang (`[pending]`)**,
consistent with the user's **network/region blocking those exchange hosts** (Delta India + Deribit
are commonly ISP/geo-restricted from India). The backend is not restricted.

**Fix direction (approved):** proxy everything through the backend and move the Delta API
key/secret + HMAC signing to the server (decided: *server-side keys + signing*).

### Chosen approach (fast + secure, no workaround)

**Target end-state = backend owns all market data AND credentials; the browser is a thin,
same-origin client holding no keys and making no exchange calls.** Live data reaches the browser
over **one WebSocket push channel** (`/ws`) plus **REST** for history/snapshots served from the
workers' cache/DB (this is Approaches B + C combined). This is the fast answer (one server
fetch/stream feeds every tab from memory; no blocked-host latency, no redundant round-trips) and
the secure answer (no browser secret, no client signing, no open relay, locked CORS, rate-limited,
single whitelisted egress IP).

**Sequencing (each step ships working software; the API seam is permanent, not throwaway):**

- **Step 1 — Same-origin seam + security:** `/api/v1/mkt/*` passthrough gateway +
  `/api/v1/delta/signed/*` server-side signing; repoint the frontend; delete browser keys. Fixes
  the indicators and secures credentials immediately. This is the final browser↔server contract.
- **Step 2 — Backend as source of truth:** promote hot paths (ticks, option chain, DVOL) onto the
  workers + a single `/ws` push; the gateway endpoints become cache/worker-backed. Browser URLs
  unchanged.
- **Step 3 — Thin client:** indicators consume pushed snapshots; retire remaining passthroughs.

The sections below detail **Step 1** (the seam + server-side signing), which the implementation
plan starts from; Steps 2–3 slot in behind the same endpoints.

---

## Root cause (one line)

Browser → exchange calls are blocked at the user's network; the Oracle server is not — so the
server must fetch and the browser must only talk to its own origin.

---

## Issues & Solutions

| # | Severity | Issue | Solution |
|---|---|---|---|
| I1 | **Blocker** | Indicators hang: browser fetches `api.india.delta.exchange`, `deribit.com`, `binance`, `okx.com`, news feeds directly; blocked from the user's network | Backend **passthrough gateway** `/api/v1/mkt/*`; frontend calls same-origin |
| I2 | **High (security)** | Delta API **secret stored in browser** (`localStorage v100_dkey`) and HMAC signature computed client-side (`hmacHex`, Web Crypto) | Store key+secret only in `.env.prod`; **sign server-side**; delete client secret + signing |
| I3 | **High (security)** | `/api/v1/delta/proxy` is a near-open relay — accepts any path starting `/v2/` and forwards client headers (SSRF / abuse surface) | Replace with **host+path allowlist**; GET-only passthrough; dedicated signed route |
| I4 | **High (broken)** | `/api/cal` (economic calendar) was a **Vercel function**; on Oracle there is no Vercel → it 404s | Add a backend `/api/cal` route (ForexFactory relay) |
| I5 | Medium | News feeds (`cryptocurrency.cv/api/breaking`, `api.llama.fi/hacks`) and OKX called directly from browser | Add `/api/v1/news` + OKX paths to the gateway |
| I6 | Medium (security) | `CORS_ORIGINS` default is permissive (`localhost:3000,4000`); prod must be explicit | Set `CORS_ORIGINS=https://suraj-voldesk.duckdns.org` in `.env.prod` |
| I7 | Medium (security) | **No rate limiting** on the backend / proxy | Add `@fastify/rate-limit` on the gateway routes |
| I8 | Low (fixed) | `/api/v1/delta/status` pinged `/v2/time` → 404, always reported `deltaReachable:false` | Fixed to `/v2/settings` (committed `fix/delta-status-endpoint`; **pending redeploy**) |
| I9 | Low (noted) | `index.html` is a 27k-line monolith mixing many concerns | Out of scope now; not refactored in this change |

---

## Target architecture

```
Browser (suraj-voldesk.duckdns.org)
  │  same-origin only — no exchange hosts
  ▼
Caddy (TLS) ──▶ Fastify app :4000
                 ├─ /api/v1/mkt/*        public passthrough (allowlisted hosts, GET, TTL cache)
                 ├─ /api/v1/delta/signed/* server-side HMAC (key+secret from .env.prod)
                 ├─ /api/v1/market/*     existing worker-fed data (reused where it fits)
                 ├─ /api/cal, /api/v1/news  calendar + news relays
                 └─ serves the static SPA
                        │ outbound = 92.4.74.5 (whitelisted)
                        ▼
      Delta · Deribit · Binance · OKX · ForexFactory · news feeds
```

All exchange traffic exits the **whitelisted static IP**. The browser never contacts an exchange.

---

## Endpoint inventory → backend mapping

Public (no key) — served via `/api/v1/mkt/<host>/<path>` passthrough with a strict allowlist:

| Host | Paths (allowlisted) |
|---|---|
| `api.india.delta.exchange` | `/v2/products`, `/v2/tickers`, `/v2/history/candles`, `/v2/l2orderbook/*`, `/v2/trades/*` |
| `www.deribit.com/api/v2/public` | `get_volatility_index_data`, `get_book_summary_by_currency`, `get_last_trades_by_currency`, `get_last_trades_by_currency_and_time` |
| Binance (`fapi.binance.com`, `api.binance.com`, `data-api.binance.vision`, `data.binance.vision`) | `/fapi/v1/klines`, `/api/v3/klines`, `/fapi/v1/openInterest`, `/fapi/v1/premiumIndex`, daily metrics `.zip` |
| `www.okx.com/api/v5/public` | `/liquidation-orders`, `/rubik/stat/contracts/open-interest-volume` |
| `cryptocurrency.cv`, `api.llama.fi` | `/api/breaking`, `/hacks` → surfaced via `/api/v1/news` |
| ForexFactory | economic calendar → `/api/cal?week=this|next` |

Signed (Delta account/P&L) — served via `/api/v1/delta/signed/*`, backend computes HMAC:
- Whatever authenticated `/v2/` endpoints the UI uses for positions / wallet / orders / fills.
- Signing scheme (ported from the current client code): `message = 'GET' + timestamp + path +
  queryString`, `signature = HMAC_SHA256(secret, message)`, headers `api-key` / `timestamp` /
  `signature`.

Reuse where it already exists: `/api/v1/market/candles` (worker-fed OHLCV) — the UI already has a
fallback to it; make it primary where shapes match.

---

## Backend changes (`backend/src/`)

1. **`routes/mkt.ts` (new)** — passthrough gateway:
   - `ALLOWLIST`: map of `{ hostKey → { host, pathPrefixes[] } }`. Reject anything not listed (403).
   - GET-only; forward query string; set `User-Agent`, `Accept`; 8–12 s timeout; return upstream
     status + JSON verbatim; `502` with clear JSON on failure.
   - **In-memory TTL cache** keyed by full URL: ~2 s (tickers/orderbook), ~30–60 s
     (candles/history/DVOL). One upstream fetch serves all browser tabs.
2. **`routes/delta.ts`** — add `/signed/*`; read `DELTA_API_KEY`/`DELTA_API_SECRET` from env; sign
   server-side. **Remove** the open client-signed `/proxy` (keep `/ip`, `/status`).
3. **Calendar — `routes/cal.ts` + hourly worker (new):** a backend worker fetches ForexFactory
   **hourly**, normalizes + caches in memory; `/api/cal?week=this|next` serves from cache
   (instant; replaces the dead Vercel function). Low churn → REST + cache, no WebSocket needed.
4. **News — `routes/news.ts` + poll worker + `/ws` push (new):** a worker polls both feeds
   (`cryptocurrency.cv/api/breaking`, `api.llama.fi/hacks`) every ~30–60 s, **merges + dedups +
   normalizes** into one rolling buffer (optionally persisted to Postgres for history/unread state).
   `/api/v1/news` (REST) serves the initial load/backfill; **new items push over `/ws`** so the
   unread pill + chime fire in real time with no browser polling. Graceful degradation: serve
   last-good cache if a feed is down.
5. **Security:** register `@fastify/rate-limit` on gateway routes; ensure no auth headers are
   logged; `CORS_ORIGINS` from env (locked in `.env.prod`).
6. **Tests (vitest):** allowlist enforcement (listed host passes, arbitrary host 403), cache
   hit/expiry, server-side signing (known key/secret → expected signature), `/signed` rejects when
   key env is absent.

## Frontend changes (`frontend/index.html`)

1. Repoint base-URL constants to the same-origin gateway: `DELTA`/`API` (4855, 14835, 15302,
   16177, 18096, 22294, 22798, 23564), `DERIBIT_API`/`DRB`/`DLT` (7242, 14834, 14835, 15685),
   Binance + OKX hosts, news hosts. Prefer routing them through the central `getJ`/`fetch` helper so
   the change is centralized rather than 45 edits.
2. **Delete** client credential + signing path: `v100_dkey` secret storage, `hmacHex`,
   `v100_droute`/`v100_dproxy` toggles. Signed data comes from `/api/v1/delta/signed/*`.
3. Keep the existing slow-lane fetch queue (lines ~530–561) — it still applies to same-origin URLs.
4. Error state: indicators that previously hung now render an "unavailable" state on `502`.

## Security hardening (summary of the "best practices" ask)

- Delta secret **server-only** (`.env.prod`), never shipped to the browser.
- Gateway **not an open relay** — strict host+path allowlist (closes I3 SSRF surface).
- `CORS_ORIGINS` locked to the production domain.
- Rate-limiting on gateway routes.
- No logging of `api-key`/`signature`.
- Live-trading behind a kill-switch env flag (do not place withdraw-capable keys on the VM).

---

## Deliverables

1. The gateway refactor (backend + frontend) above.
2. **LLM/SSH operations handoff doc** (`docs/OPERATIONS_HANDOFF.md`): live specifics so any LLM or a
   fresh session can operate the deployment over SSH — `ssh -i ~/.ssh/oracle_key ubuntu@92.4.74.5`,
   app dir `~/app`, the compose files, redeploy steps, log/exec commands, env-file layout, current
   state. Complements the generic `DEPLOY_ORACLE.md`.
3. Redeploy to Oracle; retire Railway after a clean overnight run.

## Verification

1. `vitest` green for the new gateway/signing/cache tests.
2. Browser smoke-test (Chrome DevTools) on the live site: **every** network request is same-origin
   (`suraj-voldesk.duckdns.org`); **zero** requests to exchange hosts; indicators populate; no
   console errors.
3. `curl .../api/v1/mkt/deribit/...` and `.../api/v1/delta/signed/...` return data; arbitrary host
   → 403; `/api/cal` returns calendar JSON (not 404).
4. Delta signed calls succeed from the whitelisted IP (account/P&L panels fill).

## Prerequisites / open items

- **Delta API key + secret** must be placed in `.env.prod` on the VM (user pastes over SSH, like
  `DATABASE_URL`). If the account/P&L features are not used, the signed route can be deferred and
  only the public gateway shipped (still fixes the indicators).

## Out of scope

- Breaking up the 27k-line `index.html` (I9).
- Approach B (reshaping indicators onto worker/DB data) and Approach C (WebSocket push) — kept as
  future upgrades behind the same gateway endpoints.
