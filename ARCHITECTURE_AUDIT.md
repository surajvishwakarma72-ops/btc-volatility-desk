# Volatility Desk: Full-Stack Architecture Audit & Migration Blueprint

**Audit Date:** October 18, 2026  
**Target File:** `Volatility Desk.html`  
**Total File Size:** 2,239,865 bytes (~2.24 MB)  
**Total Lines:** 24,377  
**Scope:** Read-only architectural inspection, feature mapping, persistence catalog, network dependency audit, code smell / layer analysis, and full-stack decoupling plan.

---

## 1. High-Level Anatomy of the Single-File Application

`Volatility Desk.html` is an institutional-grade, 24×7 BTC options volatility workstation designed specifically for short-strangle trading on **Delta Exchange India** with cross-venue analytics from **Deribit**, **Binance**, and **OKX**. 

Rather than undergoing continuous refactoring, the file has been maintained by **versioned layer stacking** over an extended evolutionary cycle:
- **Lines 1–470:** Extensive release notes and changelog covering versions up to **v147** (dated 18 Oct 2026, preview).
- **Lines 471–568:** `<head>` section containing UTF-8 meta, viewport definitions, Google Fonts (`Inter`, `JetBrains Mono`), and an early execution script (`v105_17Early`, L473–L559) that caps canvas pixel densities and suppresses phone lag.
- **Lines 569–4227:** Foundational desktop & mobile CSS stylesheets across 4 major blocks (`v84`, `v80Css`, `v86Css`, `v84Css`).
- **Lines 4228–4280:** Pre-body early runtime initialization scripts:
  - L4228–L4241: `v105.15` unified clock beat
  - L4242–L4250: `v105.14` phone scroll guard
  - L4251–L4254: `v86` non-blocking desk note
  - L4255–L4279: `v80` global event bus (`window.deskBus`)
- **Lines 4281–4655:** The entire static HTML DOM body markup, organized into main pages (`#pgDesk`, `#pgFlow`, `#pgEvents`, `#pgSettings`), navigation (`#nav`, `#tabbar`), and modal containers (`#moreSheet`, `#chkPop`).
- **Lines 4656–14567:** The baseline v71 modular architecture, decomposed into 39 sequential `<script>` blocks (`data-block="01_registry"` through `data-block="39_alerts"`).
- **Lines 14568–24376:** The versioned patch stack (v80 through v147), comprising **53 versioned `<script>` blocks** and **46 interleaved `<style>` blocks**. Each layer patches previous bugs, injects new indicators into the CoinGlass-style layout, overrides existing functions in the global window namespace, or alters DOM layout rules using `!important`.

---

## 2. Feature & Panel Inventory with Line Ranges & Classifications

The application contains **16 distinct functional subsystems**. Below is the exhaustive classification of each panel, its line boundaries, network dependencies, and persistence footprint.

```
Classifications used:
- Pure Frontend / UI: Operates entirely client-side using calculated or passed data.
- Live External Data: Requires external network connectivity (REST, WebSocket, or Serverless Proxy).
- Persistence: Reads or writes persistent state (localStorage or IndexedDB).
```

### Summary Feature Matrix

| # | Feature / Panel | HTML Lines | CSS Lines | Script Lines | Data Classification | Persistence Key & Storage |
|---|---|---|---|---|---|---|
| **1** | **Ticker Header Strip (`#tk`)** | L4293–L4310 | L612–L690, L3090–L3145 | L14751–L14792 (s47) | Live External Data: Delta India WS/REST, Deribit DVOL | None (ephemeral live state) |
| **2** | **Navigation, Clock & Global Controls** | L4311–L4335, L4642–L4655 | L691–L770, L3146–L3210, L21588–L21594 | L4255–L4279 (s5), L14569–L14750 (s46), L21595–L21608 (s80) | Pure Frontend / UI | `localStorage`: `btc_vol_desk_prefs_v1`, `btc_atm_iv_theme_v132` |
| **3** | **Primary BTC Candlestick Chart & Technical Overlays** | L4349–L4388 | L771–L1020, L3211–L3450, L17349–L17541, L20404–L20740, L22341–L22664 | L4840 (LWC 4.2.3), L10899–L11584 (s25), L11718–L12043 (s27–s29), L20404–L20721 (s71–s72), L20785–L21173 (s73–s76), L22397–L22664 (s86), L24037–L24090 (s91) | Live External Data: Binance REST/WS (`BTCUSDT` klines 1m/5m/15m/1h), Delta India WS | `localStorage`: `btc_drawings_v1`, `pa_layer_prefs_v3`, `v105_24Edge`; `IndexedDB`: `btc_desk_market_cache` |
| **4** | **Hero Metric Cards & ATM IV Panels** | L4391–L4410 | L1021–L1150, L17877–L17964, L18262–L18334, L23335–L23430 | L4841–L7227 (s11), L17966–L18153 (s63), L18335–L18713 (s65), L23431–L23794 (s89) | Live External Data: Delta India Options Chain REST (`/v2/tickers`) & WS | `localStorage`: `btc_expiry_list_v1`, `v100_exp`, `v104_skew` |
| **5** | **Multi-Pane Volatility Charts (Pane 0, 1, 2)** | L4411–L4442 | L1151–L1480, L3451–L3620, L16945–L17146, L21174–L21205, L21527–L21587 | L7803–L8704 (s13–s14), L13601–L13967 (s42), L16647–L16782 (s54), L16805–L17119 (s57–s58), L21018–L21173 (s74–s76), L21543–L21587 (s79) | Live External Data: Deribit DVOL REST (`/get_volatility_index_data`), Delta India ATM IV, Binance Klines | `localStorage`: `btc_rv_overlay_prefs_v1`, `v87_fast`, `v88_ba`, `rv_index_1m_v1`, `rv_index_5m_v1` |
| **6** | **Volatility Regime Detection Strip (`#regStrip`)** | L4444 | L1481–L1530, L17148–L17271 | L16122–L16645 (s53), L17273–L17347 (s59), L17349–L17521 (s60) | Live External Data: Deribit historical DVOL + Binance 1h/1d Klines | `localStorage`: `v83:regime:v1`, `v83_regime_off` |
| **7** | **Order Flow & Positioning Tape** | L4449–L4468 | L1531–L1680, L20164–L20181 | L10635–L10898 (s24), L15272–L15645 (s49) | Live External Data: Deribit trades REST (`get_last_trades_by_currency`), Binance Futures WS (`btcusdt@aggTrade`, `@depth5`, `@forceOrder`) | `localStorage`: `btc_dflow_prefs_v1`, `orderflow_boot` |
| **8** | **Futures Positioning & Liquidation Pane (v146)** | Dynamically injected in `#paneG` | L23795–L23812 | L23814–L24036 (s90), L24037–L24090 (s91) | Live External Data: Binance Futures REST (`fapi.binance.com`), Binance Public Metrics Data Archive (`data.binance.vision`), OKX Rubik Open Interest REST | `IndexedDB`: `v146fut` (store: `kv`) |
| **9** | **Trade Clock & Trade Calendar Engine (v147)** | Dynamically injected in `#chartG` | Injected inline by `window.v147` | L24091–L24374 (s92) | Live External Data: Internal clock synced to Deribit/Delta + live ADX & Speed vs IV data feed | `localStorage`: `v147_nights` |
| **10** | **Flow & Skew Analysis Page (`#pgFlow`, `#paneE`)** | L4485–L4516 | L1681–L1890 | L9237–L9445 (s16), L10262–L10634 (s23), L13553–L13600 (s41) | Live External Data: Delta India Options Chain (all strikes/expiries), Deribit Book Summary | `localStorage`: `gfs_split_v1`, `btc_impulse_prefs_v1` |
| **11** | **Macro & Crypto Events Dashboard (`#pgEvents`)** | L4517–L4545 | L1891–L2120 | L6901–L7227 (s11), L14794–L15271 (s48) | Live External Data: `cryptocurrency.cv/api/breaking` (breaking news), `api.llama.fi/hacks` (DeFi exploits), static macroeconomic schedule | `localStorage`: `btc_vol_events_custom_v1`, `ev_prefs` |
| **12** | **Decision & Scoring Engine (`#scPanel`)** | L4566–L4617 | L2121–L2260, L17877–L17964 | L12044–L12565 (s30–s31), L15646–L15875 (s50), L18161–L18258 (s64), L20785–L20985 (s73) | Pure Frontend / UI (computes verdict from live engine feeds) | `localStorage`: `vt_alert_prefs_v1`, `v89_slot` |
| **13** | **Trade Lab & Delta Strangle Tracker** | Dynamically injected `#v18Float` / `#v100Css` | L19542–L19629, L20139–L20163, L20396–L20403 | L17873–L17876 (s62), L17966–L18153 (s63), L19630–L20138 (s68), L21206–L21439 (s77) | Live External Data: Delta Exchange India Authenticated REST (Orders, Positions, Fills) via direct call or Vercel proxy (`vega-vault.vercel.app/api/delta-proxy`), `ipify.org` | `localStorage`: `v100_dkey` (API Key + Secret), `v99_trade`, `v99_trades`, `v100_dproxy`, `v18_cur`; `IndexedDB`: `suraj_archive_v1`, `v18:lab` |
| **14** | **Centralized Alert Center & Push Dispatcher** | Modal overlays & Audio engine | L23335–L23430 | L12209–L12565 (s31), L14229–L14567 (s45), L23431–L23794 (s89) | Live External Data: Telegram Bot API (`api.telegram.org`), ntfy Server Webhook (`ntfy.sh` or custom) | `localStorage`: `btc_alerts_v1`, `vt_alert_prefs_v1` (tokens/chat IDs), `v105_al`, `v105_alog` |
| **15** | **Indicator Menu / `fx` Launcher** | L4359–L4366 (`#gPanesMenu`) | L21609–L21690, L23335–L23430 | L21461–L21526 (s78), L21691–L21755 (s81), L22902–L23334 (s88), L23431–L23794 (s89) | Pure Frontend / UI | `localStorage`: `v132_ind`, `v133clean` |
| **16** | **Settings, Diagnostics & Cache Reset** | L4546–L4565, L4618–L4641 | L2261–L2500 | L7228–L7802 (s12), L16034–L16042 (s51) | Live External Data: Delta/Deribit ping latency, WebSocket heartbeat telemetry | Purges all `localStorage` and `IndexedDB` stores |

---

## 3. Detailed Feature Breakdown & Operational Logic

### 3.1 Primary BTC Chart & Technical Overlays (`#paneG`, `#chartG`)
- **Location:** HTML L4349–L4388 | CSS L771–L1020, L3211–L3450, L22341–L22664 | Scripts: L4840 (TradingView LWC v4.2.3 CDN), L10899–L11584, L20404–L20721, L24037–L24090.
- **Functionality:** 
  - Hosts TradingView Lightweight Charts (LWC 4.2.3) instance for BTC/USDT.
  - Candlestick history sourced from Binance (`api.binance.com/api/v3/klines` and `fapi.binance.com/fapi/v1/klines`) with fallback to Delta India historical candles (`api.india.delta.exchange/v2/history/candles`).
  - Overlays session timing boxes (Asia, London, NY Open, NY Close, Thane sunrise/sunset).
  - Plots N2N playbook markers (`v121`/`v122`), entry signal pills (`SELL NOW`, `EXIT NOW`, `HOLD` band), Speed vs IV rays, 3D trend levels (`line3d`), and taker-flow absorption markers.
  - Includes user drawings engine (`v60`/`v82`): horizontal rays, trendlines, and price levels stored locally.
- **Persistence:** `localStorage['btc_drawings_v1']`, `pa_layer_prefs_v3`, `v105_24Edge`. Historical candles cached in `IndexedDB['btc_desk_market_cache']`.

### 3.2 Hero Metric Cards & Options Engine (`#hero`, `#atm`, `#heroPanes`)
- **Location:** HTML L4391–L4410 | CSS L1021–L1150, L17877–L17964 | Scripts: L4841–L7227 (Core Engine `02_core`), L17966–L18153 (`v100`), L18335–L18713 (`v104`), L23431–L23794 (`v145`).
- **Functionality:**
  - Maintains the real-time Delta Exchange India options chain for BTC.
  - Automatically identifies and monitors the **Master Expiry** (the primary daily/weekly expiry for short strangles).
  - Calculates ATM Strike, ATM Straddle price, ATM IV, and aggregate portfolio Black-Scholes Greeks (Delta, Gamma, Vega, Theta).
  - Displays **MY DAY** (step-by-step progress through tonight's session) and **IV DRIVER** (put wing vs call wing 25Δ contribution to IV).
- **APIs:** Delta Exchange India REST `/v2/tickers` and WebSocket `wss://public-socket.india.delta.exchange`.
- **Persistence:** `localStorage['btc_expiry_list_v1']`, `localStorage['v100_exp']`.

### 3.3 Multi-Pane Volatility Charts (`#chartsSlotDesk`, `#pane0`, `#pane1`, `#pane2`)
- **Location:** HTML L4411–L4442 | CSS L1151–L1480, L3451–L3620, L16945–L17146, L21527–L21587 | Scripts: L7803–L8704 (`04_rv`, `05_vov`), L13601–L13967 (`36_dvol`), L16647–L16782 (`carry`), L16805–L17119 (`ivba`, `calib`), L21018–L21173 (`v122`–`v124`).
- **Functionality:**
  - **Pane 0 (IV):** Real-time and historical ATM Implied Volatility, Bid/Ask spread width, and the "Tonight" IV trajectory vs clock path.
  - **Pane 1 (RV / VRP):** Realized Volatility computed across multiple rolling windows (1h, 4h, 24h, 7d, 30d) via Parkinson and Garman-Klass estimators using 1-min and 5-min candles; plots Volatility Risk Premium ($VRP = IV - RV$).
  - **Pane 2 (VoV & Term Structure):** Volatility of Volatility (DVOL velocity) and Term Structure slope (Contango vs Backwardation) with automated backwardation risk warning badges.
- **APIs:** Deribit DVOL index (`get_volatility_index_data`), Binance 1m/5m klines, Delta ATM IV.
- **Persistence:** `localStorage['btc_rv_overlay_prefs_v1']`, `v87_fast`, `v88_ba`, cached metrics in `rv_index_1m_v1`.

### 3.4 Order Flow & Futures Positioning (`#flowRow`, `#flowTape`, `#ofTherm`, `#posPanel`, `v146`)
- **Location:** HTML L4449–L4468 | CSS L1531–L1680, L23795–L23812 | Scripts: L10635–L10898 (`17_dflow`), L15272–L15645 (`orderflow`), L23814–L24036 (`v146`).
- **Functionality:**
  - **Options Tape & Thermometer:** Aggregates real-time Deribit options trades and Delta trades; computes Delta-adjusted taker buy/sell ratios.
  - **Dealer Positioning (GEX):** Gamma exposure per strike, Net Delta positioning, and strike volume heatmaps.
  - **Futures Positioning (v146):** Binance BTCUSDT perp 5-min Open Interest (OI) changes categorized into:
    - New Longs (Price ↑, OI ↑)
    - Short Covering (Price ↑, OI ↓)
    - New Shorts (Price ↓, OI ↑)
    - Long Liquidation (Price ↓, OI ↓)
    - Taker-flow absorption dots, FUEL marks (sustained multi-hour buildup), and FLUSH marks (rapid 2σ unwinds).
- **APIs:** Deribit trade stream, Binance Futures WS (`fstream.binance.com`), Binance public daily metrics archives (`data.binance.vision`), OKX Rubik Open Interest API.
- **Persistence:** `IndexedDB['v146fut']` (stores unpacked 5-min historical metrics).

### 3.5 Trade Lab & Delta API Execution Sync (`v105_18`, `v99`, `v100`)
- **Location:** Dynamically rendered modal/drawer (`#v18Float`) | CSS L19542–L19629, L20139–L20163 | Scripts: L17873–L17876 (`v99`), L17966–L18153 (`v100`), L19630–L20138 (`v105_18`), L21206–L21439 (`v126`).
- **Functionality:**
  - Connects to Delta Exchange India account using read-only API key and secret.
  - Signs requests directly in browser using Web Crypto API (`HMAC-SHA256`).
  - Fallback relay via Vercel serverless proxy (`https://vega-vault.vercel.app/api/delta-proxy`) when browser encounters CORS or network obstacles.
  - Displays live open strangle positions, sold-at IV, current P&L, delta hedge recommendations, and P&L attribution (how much P&L came from Delta, Gamma, Theta, or Vega).
  - Diagnostic IP whitelist check using `api.ipify.org` and `api64.ipify.org` to resolve Delta API IP restriction errors.
  - Maintains trade archive and closed trade logs for post-trade analysis.
- **Persistence:**
  - `localStorage['v100_dkey']`: Stores `{ key: "...", secret: "..." }` in plaintext.
  - `localStorage['v99_trade']`, `v99_trades`, `v18_cur`.
  - `IndexedDB['suraj_archive_v1']`, `IndexedDB['v18:lab']`.

### 3.6 Trade Clock & Calendar Engine (`v147`)
- **Location:** Dynamically rendered canvas overlay on `#chartG` | Injected CSS | Scripts: L24091–L24374 (`v147`).
- **Functionality:**
  - Renders a 12-hour analog clock face on top of the BTC chart, with daytime/nighttime background shading determined by Thane sunrise/sunset coordinates.
  - Issues unambiguous state directives: `WAIT`, `SELL FULL`, `SELL HALF`, `HOLD`, `EXIT NOW`, `TOO LATE`, `NO TRADE`.
  - Evaluates 3 deterministic conditions:
    1. ATM IV below its 17:30 IST level
    2. 1-hour ADX falling
    3. Speed vs IV ratio $< 1.5\times$
  - Renders an interactive calendar tracking historical night performance (249+ tested nights), exit hour distributions, and tags (NFP, FED, OpEx).
- **Persistence:** `localStorage['v147_nights']`.

### 3.7 Centralized Alert Center (`39_alerts`, `v145`, `vtcore`, `vtui`)
- **Location:** Modal alert overlay & audio synthesize engine | CSS L23335–L23430 | Scripts: L12209–L12565 (`24_vtcore`, `25_vtui`), L14229–L14567 (`39_alerts`), L23431–L23794 (`v145`).
- **Functionality:**
  - Monitors high-urgency conditions: IV Turn, Vol Spike, Speed vs IV breakthrough, Panic Expansion, Approaching Stop-Loss.
  - Audio alert dispatch: generates synthetic audio tones via HTML5 Web Audio API.
  - Visual overlay: Full-screen modal alerts with snooze and cooldown management.
  - External push dispatch:
    - **Telegram Bot API:** Dispatches messages via POST to `https://api.telegram.org/bot<TOKEN>/sendMessage` (using `no-cors` mode in browser).
    - **ntfy:** Sends push notifications to `https://ntfy.sh/<TOPIC>` or self-hosted ntfy servers.
- **Persistence:** `localStorage['vt_alert_prefs_v1']` (stores bot token, chat ID, ntfy topic), `localStorage['btc_alerts_v1']`, `localStorage['v105_al']`.

---

## 4. Proposed Full-Stack Architecture

### 4.1 Separation of Concerns: Backend vs. Frontend

In the current single-file design, the browser directly manages API authentication, heavy data normalization, multi-year ZIP archive decompression, WebSocket connection churn, and unencrypted secret storage. A proper full-stack architecture cleanly bifurcates these responsibilities.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   FRONTEND (SPA)                                       │
│                                                                                        │
│  ┌───────────────────────┐  ┌───────────────────────┐  ┌────────────────────────────┐  │
│  │ TradingView LWC 4.2.3 │  │ CoinGlass Dark UI     │  │ Web Audio Tone Engine      │  │
│  │ - BTC Candlesticks    │  │ - fx Menu Launcher    │  │ - Audio Chimes & Synthesis │  │
│  │ - Session Boxes / Rays│  │ - Trade Clock Face    │  │ - User Snooze / Settings   │  │
│  │ - Multi-Pane Canvas   │  │ - Modals & Drawers    │  │ - Local Visual Alerts      │  │
│  └───────────▲───────────┘  └───────────▲───────────┘  └─────────────▲──────────────┘  │
│              │                          │                            │                 │
│              └──────────────────────────┴────────────────────────────┘                 │
│                                         │ Unified WebSocket / REST                     │
└─────────────────────────────────────────┼──────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              BACKEND SERVICE (API Server)                              │
│                                                                                        │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ SECURE CREDENTIAL & AUTH LAYER                                                   │  │
│  │ - Encrypted Delta API Key/Secret Storage (AES-256-GCM)                           │  │
│  │ - Server-Side HMAC-SHA256 Request Signing (No Client Secret Exposure)            │  │
│  │ - Static Backend Outbound IP (Eliminates Delta IP Whitelist Mismatches)          │  │
│  │ - Eliminates Vercel Third-Party Proxy Dependency                                 │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ INGESTION & DATA NORMALIZATION ENGINE                                            │  │
│  │ - Delta India Options Chain & Trade WS Stream (Auto-reconnecting)                │  │
│  │ - Deribit Public DVOL & Options Flow Feed                                        │  │
│  │ - Binance Klines & Futures 5-min OI Ingestor + Daily Archive Decompressor        │  │
│  │ - Macro News & Exploit Poller (cryptocurrency.cv, DeFiLlama)                     │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ COMPUTATION & TIME-SERIES ENGINE                                                 │  │
│  │ - Continuous Realized Volatility Engine (Garman-Klass, Parkinson 1m/5m)          │  │
│  │ - Master Expiry Selector & Greek Synthesizer (Delta, Gamma, Vega, Theta)         │  │
│  │ - N2N Playbook Rules Engine & 24×7 Alert Monitor (Telegram/ntfy Background Push) │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────────────────┐  │
│  │ PERSISTENCE & STORAGE (PostgreSQL / SQLite via Prisma or Drizzle)                │  │
│  │ - Trade Logs, Open/Closed Strangle Executions, Nightly Reviews (v147_nights)     │  │
│  │ - User Settings, Chart Drawings, Layout Preferences                             │  │
│  │ - Timescale / Timeseries Table for Historical IV, RV, and OI Metrics             │  │
│  └──────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 What Goes to the Backend Service

1. **Secure API Key Management & HMAC Signing:**
   - Store user Delta Exchange India API credentials securely in the database (encrypted with `AES-256-GCM`).
   - Execute all authenticated requests to `api.india.delta.exchange/v2` directly from the backend server.
   - **Benefit:** Fixes the biggest security liability in the codebase (storing API secrets in `localStorage.v100_dkey`) and eliminates reliance on the third-party proxy (`vega-vault.vercel.app`). The server will have a stable, static IP address that can be permanently whitelisted on Delta.

2. **Market Data Streamers & Polling Engine:**
   - **Delta Exchange India:** Persistent WebSocket connection to `wss://public-socket.india.delta.exchange` for live order book and tickers.
   - **Deribit:** Scheduled REST poller for DVOL index history and live option trade feeds.
   - **Binance:** Persistent WebSocket connection to `wss://fstream.binance.com` for BTCUSDT perp metrics + background downloader for `data.binance.vision` daily OI archives.
   - **External Event Feeds:** Background cron job (every 5–15 mins) polling `api.llama.fi/hacks` and breaking crypto news.
   - **Benefit:** Prevents rate-limit exhaustion, avoids CORS errors, eliminates multi-megabyte client-side downloads, and enables caching across all client sessions.

3. **Continuous Volatility & Signal Computation:**
   - Run rolling Garman-Klass and Parkinson RV estimators continuously on 1-min and 5-min candles.
   - Calculate VRP ($IV - RV$), Speed vs IV, ADX, and Term Structure slopes on the server.
   - Evaluate the N2N playbook conditions (v121/v147) in a centralized loop.

4. **24×7 Background Alerting & Notification Push:**
   - Evaluate alert conditions continuously, even when the trader's browser or mobile phone is asleep.
   - Dispatch alerts directly from the server to Telegram Bot API and ntfy servers with guaranteed delivery.

5. **Relational & Time-Series Persistence:**
   - Replace 6 separate IndexedDB databases and 30+ localStorage keys with structured relational tables:
     - `trades` (trade log, fills, entry/exit IV, realized P&L, Greeks at entry)
     - `nightly_reviews` (replaces `v147_nights` and `ivcool:nights`)
     - `chart_drawings` (replaces `btc_drawings_v1`)
     - `user_preferences` (theme, visible indicator set, risk parameters)
     - `market_timeseries` (historical 1m/5m/1h candle and IV store)

### 4.3 What Stays in the Frontend

1. **TradingView Lightweight Charts (LWC):**
   - High-performance canvas rendering of BTC candles and multi-pane indicator lanes.
   - Chart viewport navigation, crosshairs, time-axis synchronization, and tooltips.
2. **Interactive UI & Themes:**
   - CoinGlass-style near-black UI layout, responsive phone/tablet drawers, and header ticker strip.
   - Indicator launcher menu (`ƒx` menu) with instant category filtering and local visibility toggles.
   - Analog Trade Clock face (SVG/Canvas rendering driven by server state).
3. **Local Audio & Visual Interactions:**
   - Web Audio API tone synthesis for immediate user feedback.
   - Temporary UI state (active tab, expanded panels, drawer states, zoom level).

---

## 5. Code Smells & Porting Risks in the Stacked Layers

The audit revealed severe architectural debt caused by stacking ~49 version layers over time without consolidating earlier code:

### 5.1 Function Overwriting & Monkey-Patching in Global Scope
- Functions are repeatedly declared and overwritten across different `<script>` tags without namespacing or modules.
- **Audit Findings:**
  - `tick` is defined **31 separate times** across the codebase (e.g., L8636, L9795, L10599, L12544, L12973, L13594).
  - `paint` is defined **17 times** (L8155, L8606, L9926, L10196, L11644, etc.).
  - `compute` is defined **11 times** (L5197, L8464, L10152, L11250, etc.).
  - `render` is defined **10 times** (L5376, L10835, L13190, L14176, etc.).
  - `boot` is defined **10 times** (L9222, L13945, L17860, L18145, etc.).
  - `ncdf` (Normal Cumulative Distribution Function) is independently reimplemented **5 times** (L6570, L15697, L17592, L18375, L21228).
- **Porting Risk:** If scripts are bundled or loaded in a slightly different sequence in a modern bundler (e.g., Vite/Webpack), the wrong version of a function will prevail, breaking math calculations or rendering.

### 5.2 Timer Explosion & Racing Loops
- The codebase contains **148 `setInterval` calls** and **257 `setTimeout` calls**.
- In early scripts, `v105.15` (L4228) and `v80` (L4255) explicitly attempted to unify timers into a single 1-second pulse (`window.deskBus`). However, subsequent version blocks (v88, v100, v105, v118, v136, v142, v146) disregarded this pattern and initiated their own independent intervals for polling klines, repainting charts, checking order books, and running animations.
- **Porting Risk:** Extreme CPU consumption, memory leaks, and unpredictable race conditions where multiple intervals compete to update the same DOM nodes or chart series simultaneously.

### 5.3 Storage Fragmentation & Inconsistent Keys
- Data persistence is split haphazardly across **6 different IndexedDB databases** and **over 30 distinct localStorage keys**:
  - IndexedDB databases:
    1. `btc_desk_market_cache` (store: `kv`)
    2. `btc_atm_iv_persistent_v30` (store: `state`)
    3. `suraj_archive_v1` (historical options & rule test data)
    4. `suraj_ind_v1` (store: `rows`)
    5. `v146fut` (store: `kv` for Binance futures metrics)
    6. `v18:lab` (trade lab records)
  - localStorage keys use varying naming schemes based on whichever version created them: `v80_gpanes`, `v83:regime:v1`, `v84_cv_exp`, `v87_fast`, `v88_ba`, `v89_slot`, `v99_trade`, `v99_trades`, `v100_dkey`, `v104_skew`, `v105_3d`, `v132_ind`, `v143_skin`, `v147_nights`.
- **Porting Risk:** Data inconsistency, silent failures when schemas diverge, and lack of atomic updates. Migrating directly without a unified schema will corrupt user trade logs and preferences.

### 5.4 Unencrypted Client-Side Credentials & Fragile Proxy Architecture
- `localStorage['v100_dkey']` stores the user's Delta Exchange India API Key and Secret in unencrypted JSON.
- Browser requests use Web Crypto `crypto.subtle` to sign requests with `HMAC-SHA256` (L18083). When browser CORS blocks direct requests to Delta, it falls back to a public Vercel function: `https://vega-vault.vercel.app/api/delta-proxy`.
- In `v105_18` (L20091), the client queries `api.ipify.org` and `api64.ipify.org` to display the client's public IP so the user can whitelist it on Delta. However, if the Vercel proxy is used, requests originate from Vercel's dynamic serverless IP pool, causing Delta to reject requests with `ip_not_whitelisted`.
- Telegram bot tokens (`vtTgTok`) and chat IDs (`vtTgChat`) are also stored in plaintext in localStorage.
- **Porting Risk:** Critical security vulnerability (XSS can extract API keys and Telegram bot tokens) and constant connectivity failures due to IP whitelisting mismatches.

### 5.5 Zombie Event Listeners & Memory Leaks
- The codebase attaches **327 event listeners** (`addEventListener`).
- When panels or indicators are toggled on/off in `v132`, `v138`, or `v142`, DOM elements are repeatedly emptied (`innerHTML = ''`) or detached without invoking `removeEventListener`.
- **Porting Risk:** Retained DOM trees in memory, event bubbling duplication, and phantom callbacks firing on destroyed elements.

### 5.6 CSS `!important` Cascade Conflicts
- There are **50 separate `<style>` tags** in the file.
- Stylesheets from `v105Polish`, `v105Heavy`, `v113Glass`, `v132Css`, and `v143Css` override basic layout properties using extensive `!important` declarations to force dark theme or CoinGlass styles.
- **Porting Risk:** Extracting components into modular CSS/Tailwind without a clean design token system will cause major visual regressions, misplaced panes, and broken responsive layouts.

---

## 6. Open Questions for Abhishek

Before scaffolding the new full-stack codebase, decisions are required on the following points:

1. **Deployment Target & Multi-Tenancy:**
   - Is this web app intended strictly as a **single-user personal trading desk** for you/Suraj hosted on a private VPS/local server, or will it become a **multi-user SaaS** where different traders log in with their own Delta keys and trade logs?
2. **Delta API Proxy & Server IP:**
   - Moving HMAC signing and Delta API communication to the backend will completely eliminate `vega-vault.vercel.app` and client-side secret exposure. Does your Delta API key have IP whitelisting enabled, and do you have a dedicated server/VPS with a static IP ready to whitelist on Delta?
3. **Historical Data Migration:**
   - Do you need to preserve existing trade history and night logs currently stored inside your browser (`localStorage` keys `v99_trades`, `v147_nights`, and IndexedDB `suraj_archive_v1`), or can the new database start fresh? (We can build a one-click "Import from Browser" JSON uploader if needed).
4. **Binance Futures Archive Ingestion:**
   - `v146` downloads multi-megabyte daily metric ZIP files (`BTCUSDT-metrics-${day}.zip`) from `data.binance.vision` to parse 5-min historical OI. Should the backend service run an automated background pipeline to ingest and store this data in a database, or do you only need live 30-day lookback data from the standard Binance Futures REST API?
5. **Indicator Defaults & Layout Selection:**
   - The file contains legacy layouts (v71, v80, v89) alongside the newer **CoinGlass skin (v132/v143)** and the **v147 Trade Clock**. Can we cleanly deprecate the obsolete legacy layouts and build exclusively around the approved CoinGlass single-panel desk with the `ƒx` indicator menu?
6. **Push Alert Channels:**
   - Both **Telegram Bot** and **ntfy** push notifications exist in the codebase. Which channel do you actively use and prioritize for real-time mobile trade signals?
7. **Preferred Backend Technology:**
   - For the backend service, do you have a strong preference between **Node.js/TypeScript** (e.g., Fastify / Express with Prisma/Drizzle) vs. **Python** (e.g., FastAPI with SQLAlchemy) vs. **Go**? (Node.js/TypeScript allows sharing TypeScript interfaces and Greek calculation math between frontend and backend).

---

## 7. Migration Roadmap (Next Steps)

Once Abhishek reviews this audit and provides decisions on the open questions, the recommended execution phases will be:

- **Phase 1: Database Schema & Backend Core**
  - Define relational schema (Users/Credentials, Trades, Market Snapshots, Nightly Reviews, Preferences).
  - Implement secure Delta API client with server-side HMAC signing and encrypted secrets.
  - Implement ingestion workers for Delta WS, Deribit REST, and Binance Futures.
- **Phase 2: Signal Engine & Background Services**
  - Consolidate Black-Scholes Greeks, Garman-Klass / Parkinson RV, Speed vs IV, and ADX calculations into a single, tested mathematical module.
  - Set up server-side alert monitor and background Telegram/ntfy dispatchers.
  - Establish a unified WebSocket gateway for streaming normalized market data and trade updates to clients.
- **Phase 3: Modern Frontend Architecture**
  - Build a clean, responsive frontend application utilizing modern component structure and TradingView Lightweight Charts.
  - Implement the CoinGlass dark UI design system, indicator toggles, Trade Clock, and Trade Lab panels.
- **Phase 4: Validation & Parity Testing**
  - Run side-by-side verification between `Volatility Desk.html` and the full-stack app to ensure exact numerical parity across ATM IV, Greeks, RV windows, and playbook verdicts.
