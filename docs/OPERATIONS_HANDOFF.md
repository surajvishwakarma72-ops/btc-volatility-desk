# Operations Handoff — BTC Volatility Desk (Oracle)

Operator guide for **any LLM or human** picking up this deployment. It captures the *live, concrete*
specifics so you can operate over SSH without re-discovering anything. Pairs with the generic
runbook `DEPLOY_ORACLE.md` and the refactor spec/plan under `docs/superpowers/`.

> Treat anything here as the source of truth for "how the running system is wired." Verify a detail
> (IP, file, flag) still holds before acting on it — stamp any change you make in **Current state**.

## Access

```bash
ssh -i ~/.ssh/oracle_key ubuntu@92.4.74.5      # user: ubuntu; key lives on the operator's machine
```
- **VM:** Oracle Always-Free `VM.Standard.E2.1.Micro`, Ubuntu 24.04, 1 GB RAM + 2 GB swap.
- **Public/egress IP:** `92.4.74.5` (RESERVED — survives restart; this is the IP whitelisted on Delta).
- **URL:** `https://suraj-voldesk.duckdns.org` (DuckDNS → the IP; Caddy auto-HTTPS via Let's Encrypt).
- App directory on the VM: `~/app`.

## Stack (2 containers, see `docker-compose.prod.yml`)
- `caddy` (ports 80/443) → reverse-proxies everything to `app:4000`; holds the TLS cert in the
  `caddydata` volume (do NOT delete it — Let's Encrypt rate-limits re-issues).
- `app` = Fastify (Node 20) serving the API + WebSocket + the built static SPA on :4000, built from
  the repo root `Dockerfile`. `mem_limit: 512m`, `trustProxy` on (so rate-limiting sees the real
  client IP behind Caddy).
- **Postgres is external (Neon)** via `DATABASE_URL` — no DB container, no backups to run here.

## Secrets / env (VM only, never in git)
- `~/app/.env` — `DOMAIN=suraj-voldesk.duckdns.org` (read by docker compose for Caddy + CORS).
- `~/app/.env.prod` (chmod 600) — `DATABASE_URL` (Neon), `CORS_ORIGINS=https://suraj-voldesk.duckdns.org`,
  optional alert tokens. Template: `backend/.env.prod.example` (committed).
- **`DELTA_API_KEY` / `DELTA_API_SECRET` are intentionally NOT set** (see Architecture below).

## Day-2 commands
```bash
cd ~/app
# redeploy after a merge to main (from the operator's laptop, repo root):
VM_IP=92.4.74.5 ./deploy.sh                 # git archive -> scp -> up -d --build
# or, on the VM after editing locally:
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail 200 app
docker compose -f docker-compose.prod.yml restart app
free -m ; docker stats --no-stream           # memory check on the 1 GB box
docker image prune -f                         # reclaim disk after rebuilds
```
Health checks:
```bash
curl https://suraj-voldesk.duckdns.org/health                 # {"status":"ok",...}
curl https://suraj-voldesk.duckdns.org/api/v1/delta/ip        # must return 92.4.74.5
curl https://suraj-voldesk.duckdns.org/api/v1/delta/status    # deltaReachable:true
```

## Architecture (post-gateway refactor)
The **browser only ever talks to its own origin.** All exchange/data access is proxied by the
backend (which reaches exchanges fine from the unrestricted VM IP; the browser's network is blocked
from Delta/Deribit):
- **Public market data:** browser → `GET /api/v1/mkt?u=<encoded exchange url>` → backend fetches an
  **allowlisted** host/path (`backend/src/lib/upstream-allowlist.ts`), caches briefly, returns
  verbatim. The frontend rewrites external URLs to this in its global `fetch` wrapper
  (`frontend/index.html`, `gwRewrite`).
- **Calendar:** `GET /api/cal?week=this|next` (backend relay of ForexFactory, 1h cache) — replaces
  the old Vercel function.
- **Authenticated Delta (account/P&L):** **DORMANT.** `GET /api/v1/delta/signed` exists and signs
  server-side with `DELTA_API_KEY`/`DELTA_API_SECRET`, but those env vars are deliberately unset, so
  it returns `503`. The frontend's `dget` is a stub (throws, never calls it). Reason: the desk has
  **no login**, so a server-signed endpoint would expose account data to anyone who knows the URL.

## Enabling account/P&L later (the deferred Step 2)
Do BOTH, in order:
1. **Add real auth** (the backend already has `@fastify/jwt` + an `auth` route scaffold) and gate
   `/api/v1/delta/signed` behind it so only the logged-in operator can call it.
2. Then set `DELTA_API_KEY` + `DELTA_API_SECRET` in `~/app/.env.prod`, redeploy, and re-point the
   frontend `dget` stub (`frontend/index.html`) to `GET /api/v1/delta/signed?path=...&query=...`.
   (Also planned for Step 2: a news poll worker + a single `/ws` push channel + thin-client indicators.)

## Current state
- **2026-10-21:** Gateway refactor on branch `feat/backend-data-gateway` — backend Tasks 1–5 + frontend
  Tasks 6–7 complete, backend suite green. NOT yet merged/deployed at time of writing (deploy is the
  final task). Production still serves the pre-refactor build until then. `/signed` dormant by design.
