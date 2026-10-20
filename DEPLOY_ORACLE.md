# Deploying the BTC Volatility Desk on Oracle Cloud (Always Free)

Self-hosted, ~$0/month replacement for Railway. Adapted from `DEPLOYMENT_BLUEPRINT.pdf`
(**Oracle VM + 2 GB swap + Docker Compose + Caddy auto-HTTPS + DuckDNS**).

**Why move off Railway:** Railway hands the backend a *dynamic* outbound IP, which breaks
Delta Exchange's API-key IP allowlist. An Oracle VM with a **reserved public IP** gives a
stable egress IP we can whitelist — that's the whole point (see [Part C](#part-c)).

**No application code changes are needed.** The app is already env-driven (`PORT`, `HOST`,
`DATABASE_URL`, `CORS_ORIGINS`) and binds `0.0.0.0`.

## Architecture (2 containers)

```
Internet :80/:443
   │  <name>.duckdns.org → VM public IP
   ▼
 Oracle VM (Ubuntu 22.04, Docker)
   caddy :80/:443  ──reverse_proxy──▶  app:4000
   (auto-HTTPS)                        Fastify: API + /ws + static SPA
                       │ outbound = VM's RESERVED public IP
                       ▼
     Neon Postgres (SSL)  ·  Delta/Deribit/Binance APIs (IP-whitelisted)
```

Only Caddy is published. `app` has no public port; Caddy reaches it over the Docker network.
Postgres stays on **Neon** (managed) — no DB container, nothing to back up on the VM.

Files in this repo that make it work: `Dockerfile` (existing, reused), `docker-compose.prod.yml`,
`Caddyfile`, `.env.prod.example`, `deploy.sh`.

---

## Part A — One-time VM setup

Placeholders: `<VM_IP>`, `<name>.duckdns.org`.

1. **Create the VM** — cloud.oracle.com → Compute → Instances → Create.
   Image **Ubuntu 22.04**; shape **VM.Standard.E2.1.Micro** (1 GB, always available).
   *(Optional upgrade: Ampere A1 — 4 vCPU/24 GB free — if your region has capacity; it removes
   the swap/memory pressure entirely. Node/Fastify runs fine on ARM64.)*
   Add an SSH key: `ssh-keygen -t ed25519 -f ~/.ssh/oracle_key`. Note the public IP; test
   `ssh -i ~/.ssh/oracle_key ubuntu@<VM_IP>`.

2. **Open ports 80 & 443 (Oracle has TWO firewalls)**
   - Cloud: Instance → Subnet → **Security List** → add Ingress rules: source `0.0.0.0/0`, TCP,
     destination ports `80` and `443`.
   - On the VM (Oracle's Ubuntu ships strict iptables):
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```
   Do **not** open 4000 — only Caddy is public.

3. **Add 2 GB swap (mandatory on the 1 GB box)**
   ```bash
   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf && sudo sysctl --system
   ```

4. **Install Docker**
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
   sudo usermod -aG docker $USER      # then log out and back in
   docker compose version             # sanity check
   ```

5. **Free domain (DuckDNS)** — duckdns.org → sign in → add a subdomain `<name>` → set its IP to
   `<VM_IP>` → *update ip*. Verify: `ping <name>.duckdns.org` shows `<VM_IP>`.
   (Oracle public IPs are stable while the instance exists, so no updater cron is needed.)

---

## Part B — Deploy

6. **Get the code onto the VM.** From your laptop (repo root):
   ```bash
   VM_IP=<VM_IP> ./deploy.sh
   ```
   (`deploy.sh` tars `HEAD`, scps it, unpacks to `~/app`, and runs `up -d --build`. It refuses to
   deploy until the secret files exist — do step 7 first.) Or `git clone <repo> ~/app` on the VM.

7. **Create the env files on the VM** (never committed, survive redeploys):
   ```bash
   cd ~/app
   echo "DOMAIN=<name>.duckdns.org" > .env            # read by docker compose (Caddy + CORS)
   cp .env.prod.example .env.prod && nano .env.prod   # Neon DATABASE_URL, JWT_SECRET,
                                                       # ENCRYPTION_MASTER_KEY, Delta URL, alerts
   chmod 600 .env .env.prod
   ```

8. **Launch**
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build > ~/deploy.log 2>&1; tail ~/deploy.log
   docker compose -f docker-compose.prod.yml ps        # app + caddy should be Up
   docker compose -f docker-compose.prod.yml logs -f app
   ```
   First build (`tsc && vite build` for the ~27k-line `index.html` + the backend) takes a few
   minutes on the 1 GB box — it leans on swap. Caddy fetches the TLS cert on the first HTTPS
   request (~30 s).

9. **Verify** — `curl https://<name>.duckdns.org/health` → `{"status":"ok",...}`. Open the site;
   confirm the WebSocket connects (DevTools → Network → WS) and the rulebook/backtest data loads.

---

<a name="part-c"></a>
## Part C — Delta static-IP whitelist (the reason for the move)

1. **Reserve the public IP** so it survives stop/restart: Oracle → Instance → attached VNIC →
   IPv4 addresses → convert the ephemeral public IP to a **Reserved Public IP** (free, 1 included).
2. On a single-NIC VM the **egress IP equals that public IP**. Confirm from the running app:
   `curl https://<name>.duckdns.org/api/v1/delta/ip` → returns `<VM_IP>`.
3. In the **Delta Exchange** dashboard, edit the API key's **IP allowlist** → add `<VM_IP>`.
4. End-to-end: `curl https://<name>.duckdns.org/api/v1/delta/status` → HTTP 200 with healthy
   latency. The HMAC relay now passes the whitelist (this failed on Railway's rotating IPs).

---

## Part D — Day-2 operations

| Task | Command |
|---|---|
| Redeploy after changes | `VM_IP=<ip> ./deploy.sh` (or `git pull` on the VM) then `up -d --build` |
| Logs | `docker compose -f docker-compose.prod.yml logs --tail 200 app` |
| Restart one service | `docker compose -f docker-compose.prod.yml restart app` |
| Memory check | `free -m` ; `docker stats --no-stream` (app should sit well under 512 MB) |
| Disk cleanup | `docker image prune -f` (old images pile up after rebuilds) |

**Uptime alert (free):** create a check at healthchecks.io (period 2 min, grace 5 min), store its
ping URL in `/etc/hc-ping.url` (chmod 600), and cron every 2 min: curl `/health`, and if it returns
`"status":"ok"`, ping the healthchecks URL. If the site dies, pings stop and you get an email.

**Database backups** are Neon's responsibility (managed) — nothing to run on the VM.

---

## Gotchas (1 GB box)

- **Swap, not a crash.** Without the 2 GB swap + `mem_limit: 512m`, the box swap-thrashes and
  `/health` times out while CPU looks idle. Both are already in `docker-compose.prod.yml` + step 3.
- **The build is the heavy moment.** Batch changes into one deploy. If the on-VM build ever OOMs,
  build the image locally / in GitHub Actions and transfer it instead of building on the VM.
- **Keep the `caddydata` volume.** Deleting it re-requests certs and can hit Let's Encrypt rate
  limits.
- **Back up `ENCRYPTION_MASTER_KEY` / `JWT_SECRET`** somewhere off the VM — lose the key and stored
  encrypted secrets become unreadable.
- **Don't put withdraw-capable exchange keys on a free VM.** Keep a kill switch; prefer
  trade-/read-scoped keys.

## Cutover checklist

- [ ] VM created, SSH works
- [ ] Ports 80/443 open in Security List **and** iptables
- [ ] 2 GB swap on
- [ ] Docker + compose plugin installed
- [ ] DuckDNS subdomain → VM IP
- [ ] Code on VM; `.env` + `.env.prod` filled, `chmod 600`
- [ ] `up -d --build`; `app` + `caddy` both Up
- [ ] `https://<name>.duckdns.org/health` → ok, padlock valid, WebSocket connects
- [ ] Public IP reserved; `/api/v1/delta/ip` returns it; whitelisted on Delta; `/delta/status` 200
- [ ] Ran cleanly for one full overnight session → **then** stop the Railway service
