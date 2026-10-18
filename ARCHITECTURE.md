# Volatility Desk: System Architecture Blueprint

**Status:** Approved Architecture Specification  
**Deployment Target:** Railway / Render (Managed Node.js + Managed PostgreSQL)  
**Primary Execution Paradigm:** Always-on Backend Service + High-Performance Frontend SPA  
**Audited Reference:** [`ARCHITECTURE_AUDIT.md`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/ARCHITECTURE_AUDIT.md)

---

## 1. Architectural Evolution & Decisions

The BTC Volatility Desk is transitioning from a monolithic single-file HTML prototype (`Volatility Desk.html`, ~24,000 lines) into a decoupled, institutional-grade full-stack trading application.

### Key Architectural Decisions

1. **Always-On Backend Service (Railway / Render):**
   - The backend is implemented as a persistent, 24×7 Node.js/TypeScript server rather than ephemeral serverless functions (e.g., Vercel).
   - **Rationale:** Options volatility trading requires continuous state evaluation: continuous 1-minute/5-minute Realized Volatility (Garman-Klass / Parkinson) calculation, persistent WebSocket streaming from Delta Exchange India and Binance Futures, scheduled decompression of daily Binance Open Interest metrics, and 24×7 alert monitoring. Serverless functions suffer from cold starts, lack persistent WebSocket connections, and cannot maintain continuous background polling.
   - Hosted on **Railway** or **Render** with an attached managed **PostgreSQL** instance and a static outbound IP for Delta API whitelisting.

2. **Single-User First, Multi-User Ready from Day One:**
   - The application is optimized for Abhishek / Suraj's daily short-strangle execution, but architectural foundations include user accounts (`users` table, JWT authentication scaffolding, multi-tenant relational foreign keys).
   - **Rationale:** Starting with user identity from Day 1 guarantees that transitioning to a multi-trader desk or SaaS later will require zero schema refactoring or database migrations.

3. **Canonical PostgreSQL Storage + Client-Side Offline Cache:**
   - **PostgreSQL** is the sole authoritative system of record for:
     - User accounts and encrypted exchange credentials (`api_credentials`).
     - Live and historical trades, strangle fills, and P&L attribution (`trades`).
     - Nightly reviews and calendar performance records (`nightly_reviews`, replacing `v147_nights` and `ivcool:nights`).
     - Chart drawings, trendlines, and horizontal rays (`chart_drawings`, replacing `btc_drawings_v1`).
     - User workspace preferences, indicator presets, and theme settings (`user_preferences`).
     - Historical market time-series (candles, IV, RV, OI metrics).
   - **Repurposed IndexedDB:** The client-side IndexedDB schema (detailed in [`DB_SCHEMA.md`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/DB_SCHEMA.md)) is repurposed strictly as an offline-first read cache and optimistic write buffer. The frontend operates instantly from IndexedDB and synchronizes bidirectionally with PostgreSQL in the background.

4. **Server-Side 24×7 Alert Dispatching (Telegram Bot + ntfy):**
   - In the legacy prototype, alerts were evaluated inside the browser tab (`v145` alert center, `vtcore`), meaning critical exit/panic signals were missed whenever the trader's laptop was closed or phone was asleep.
   - In the full-stack architecture, alert evaluation runs continuously inside the backend service. When trigger conditions are met (IV spike, RV surge, Speed vs IV breakthrough, stop-loss threshold), the backend dispatches notifications directly to:
     - **Telegram Bot API** (`https://api.telegram.org/bot<TOKEN>/sendMessage`)
     - **ntfy Gateway** (`https://ntfy.sh/<TOPIC>` or self-hosted ntfy server)
   - Notifications fire reliably with zero dependency on an open browser session.

5. **One-Time Historical Browser Data Migration:**
   - A dedicated migration bridge will export existing browser data (the 30+ `localStorage` keys and the 6 IndexedDB databases cataloged in [`ARCHITECTURE_AUDIT.md`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/ARCHITECTURE_AUDIT.md)) into a validated JSON payload and ingest it into PostgreSQL prior to cutover.
   - Detailed specification defined in [`MIGRATION.md`](file:///c:/Users/suraj/OneDrive/Desktop/BTC%20Volatility%20Desk/MIGRATION.md).

---

## 2. Technology Stack & Framework Selection

### Backend Framework: Fastify vs. Express

**Selected Framework: Fastify (Node.js + TypeScript)**

| Evaluation Dimension | Fastify | Express | Architectural Decision Rationale |
|---|---|---|---|
| **Throughput & Latency** | ~75,000 req/sec, ultra-low overhead | ~15,000 req/sec | **Fastify wins.** Options volatility desks process frequent ticks, high-volume order flow, and multi-indicator requests. Low event-loop latency is critical. |
| **TypeScript Support** | Native, first-class typing & schema inference | Requires community `@types` and ad-hoc typing | **Fastify wins.** Built-in TypeBox / JSON Schema integration allows end-to-end type safety from route schemas to TypeScript types. |
| **WebSocket Integration** | `@fastify/websocket` runs natively on the Fastify instance | Requires disjoint `ws` server plumbing | **Fastify wins.** Unified port and lifecycle management for both HTTP endpoints and real-time WebSocket client streaming. |
| **Encapsulation & Architecture** | Plugin architecture with isolated scopes | Monolithic middleware chain prone to collisions | **Fastify wins.** Clean separation of database connectors, authentication hooks, and route domains. |
| **Maintenance & Ecosystem** | Actively maintained, modern standard | Slow release cadence, legacy architectural patterns | **Fastify wins.** Modern async/await and native JSON serialization out of the box. |

---

## 3. High-Level System Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   FRONTEND (SPA)                                       │
│                                                                                        │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────────────────┐  │
│  │ TradingView LWC 4.2.3 │  │ CoinGlass Dark UI     │  │ Web Audio Tone Engine      │  │
│  │ - BTC Candlesticks    │  │ - fx Menu Launcher    │  │ - Local Audio Feedback     │  │
│  │ - Session Boxes / Rays│  │ - Trade Clock Face    │  │ - Visual Modal Overlays    │  │
│  │ - Multi-Pane Canvas   │  │ - Modals & Drawers    │  │ - Immediate UI Feedback    │  │
│  └───────────▲───────────┘  └───────────▲───────────┘  └─────────────▲──────────────┘  │
│              │                          │                            │                 │
│              └──────────────────────────┴────────────────────────────┘                 │
│                                         │                                              │
│                                         ▼                                              │
│                        ┌─────────────────────────────────┐                             │
│                        │ CLIENT-SIDE INDEXEDDB CACHE     │                             │
│                        │ - Offline-first Read Cache      │                             │
│                        │ - Optimistic Write Buffer       │                             │
│                        └────────────────▲────────────────┘                             │
└─────────────────────────────────────────┼──────────────────────────────────────────────┘
                                          │ Bidirectional Sync & WebSocket Feeds
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              BACKEND SERVICE (Fastify + TS)                            │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ AUTHENTICATION & SECURE CREDENTIAL LAYER                                         │  │
│  │ - JWT Session & User Management (`users`)                                        │  │
│  │ - AES-256-GCM Encrypted Delta API Key/Secret Storage                             │  │
│  │ - Server-Side HMAC-SHA256 Request Signing (No Client Secret Exposure)            │  │
│  │ - Static Outbound IP (Guarantees Delta IP Whitelist Compliance)                  │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ INGESTION & DATA NORMALIZATION WORKERS                                            │  │
│  │ - Delta Exchange India WS (`wss://public-socket.india.delta.exchange`)           │  │
│  │ - Deribit Public REST (`/get_volatility_index_data`, `/get_last_trades`)          │  │
│  │ - Binance Futures WS (`btcusdt@aggTrade`, `@depth5`, `@forceOrder`)              │  │
│  │ - Binance Public Metrics Archive Downloader (Daily 5-min OI Decompression)       │  │
│  │ - Macro News & Exploit Poller (`cryptocurrency.cv`, `api.llama.fi`)              │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ COMPUTATION & SIGNAL ENGINE                                                      │  │
│  │ - Continuous Realized Volatility Engine (Garman-Klass, Parkinson 1m/5m)          │  │
│  │ - Master Expiry Selector & Black-Scholes Greeks (Delta, Gamma, Vega, Theta)      │  │
│  │ - N2N Playbook State Machine (v121 / v147 Trade Clock Rules)                     │  │
│  │ - 24×7 Background Alert Engine (Dispatches Telegram Bot API & ntfy)              │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ REST & WEBSOCKET API GATEWAY (/api/v1/...)                                       │  │
│  │ - `/routes/auth.ts`         - `/routes/trades.ts`       - `/routes/nights.ts`    │  │
│  │ - `/routes/drawings.ts`     - `/routes/preferences.ts`  - `/routes/market.ts`    │  │
│  │ - `/routes/alerts.ts`       - `/routes/delta.ts`        - `/routes/migration.ts` │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────┼──────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              POSTGRESQL (Canonical Store)                              │
│                                                                                        │
│  - `users` (trader identity, credentials, role)                                        │
│  - `api_credentials` (encrypted exchange keys, salt, iv)                              │
│  - `trades` & `trade_fills` (open & closed strangle positions, P&L, entry Greeks)      │
│  - `nightly_reviews` (replaces `v147_nights` and `ivcool:nights`)                      │
│  - `chart_drawings` (replaces `btc_drawings_v1`)                                       │
│  - `user_preferences` (theme, active indicator presets, desk preferences)             │
│  - `alert_rules` & `alert_logs` (thresholds, snoozes, push delivery logs)              │
│  - `market_timeseries` (historical candles, DVOL, RV, open interest metrics)           │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Backend Project Structure

The backend is organized as an independent Node.js + TypeScript project located in `/backend`:

```text
/backend
  ├── package.json               # Fastify, Drizzle/Prisma, TypeScript dependencies
  ├── tsconfig.json              # Strict NodeNext/ES2022 TypeScript configuration
  ├── .env.example               # Database URL, JWT secret, encryption keys
  └── src/
      ├── index.ts               # Process bootstrap and graceful shutdown hooks
      ├── server.ts              # Fastify application factory, plugin registration
      ├── routes/                # API route controllers (empty stubs with comments)
      │   ├── auth.ts            # Registration, login, session validation
      │   ├── trades.ts          # Strangle positions, executions, trade logs
      │   ├── nights.ts          # Nightly calendar reviews, N2N trade history
      │   ├── drawings.ts        # Technical analysis drawings & trendlines
      │   ├── preferences.ts     # User settings, themes, active indicators
      │   ├── market.ts          # Klines, ATM IV, RV, VoV, DVOL, open interest
      │   ├── alerts.ts          # Alert rules, thresholds, dispatch history
      │   ├── delta.ts           # Delta Exchange India authenticated API proxy
      │   └── migration.ts       # One-time browser data import endpoint
      ├── db/                    # Database client, schema definitions, migrations
      ├── services/              # External API adapters & computation workers
      ├── plugins/               # Fastify plugins (JWT, CORS, WebSocket, error handler)
      └── types/                 # TypeScript interfaces, DTOs, and route schemas
```

---

## 5. Security Architecture

1. **Exchange Secret Protection:**
   - Client browsers **never** receive or store the Delta API Secret.
   - Secrets are stored in PostgreSQL using `AES-256-GCM` authenticated encryption with an environment-level master key (`ENCRYPTION_KEY`).
   - The backend signs all outgoing Delta requests with `HMAC-SHA256` in memory.
2. **Fixed Static IP & Whitelisting:**
   - Deployed on Railway/Render with a dedicated static outbound IP.
   - Solves the recurring `ip_not_whitelisted` failure present in the client-side Vercel proxy.
3. **Session Authentication:**
   - Stateless JWT tokens passed via `HttpOnly`, `SameSite=Strict`, `Secure` cookies.
