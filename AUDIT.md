# BTC Volatility Desk: System Audit Report (Task T0.1)

**Execution Date:** 2026-10-30  
**Audit Mode:** Read-Only Audit (No code files modified)  
**Governing Documents:** `BTC_Desk_Agent_Execution_Plan.md` and `BTC_Volatility_Desk_Master_Plan_v2.md`

---

## 1. Repo Map

| Directory / File | Language / Framework | Purpose |
|---|---|---|
| `backend/` | Node.js (v20+), TypeScript, Fastify | REST API, WebSocket server, authenticated Delta HMAC gateway, bot trading engine, paper terminal, background market workers. |
| `frontend/` | TypeScript, Vite (v8.3), HTML5, Lightweight Charts | Single-page options workstation UI (`frontend/index.html` bundled into `dist/`). |
| `frontend/index.html` | HTML5, Vanilla JS, CSS3 (3.9 MB) | Core terminal application containing ~149 modular scripts and stylesheets. |
| `backend/src/db/` | TypeScript, Drizzle ORM, `pg` Pool | Database connection and table schemas for PostgreSQL (Neon). |
| `backend/src/routes/` | TypeScript, Fastify Plugins | API endpoints (`/auth`, `/bot`, `/delta`, `/mkt`, `/algo`, `/paper`, `/watch`, `/score`, `/telemetry`). |
| `backend/src/lib/` | TypeScript | Pure domain logic: `bot/` (strike picker, schedule, sizing), `ask/` (nlp parser, wizard), `algo/`. |
| `backend/src/services/`| TypeScript | Stateful background services: `bot-engine`, `paper-terminal`, `watch`, `delta-keys`, `macro-stress`. |
| `data/` | JavaScript / JSON datasets | Static backtest datasets (`shadow_backtest_dataset.js`, `n2n_iv_path.js`, `rulebook.js`). |
| `scripts/` | Node.js / JavaScript | Quantitative research, IV studies, historical calibration scripts. |
| `Dockerfile` | Multi-stage Docker | Stage 1: build frontend; Stage 2: build backend; Stage 3: node runner. |
| `docker-compose.prod.yml`| Docker Compose | Production stack for Oracle Cloud VM (`app` Fastify + `caddy` reverse proxy). |

### How to Build, Test, and Run

- **Build Backend:** `npm --prefix backend run build` (`tsc`)
- **Build Frontend:** `npm --prefix frontend run build` (`tsc && vite build`)
- **Build All (Root):** `npm run build`
- **Run Backend Tests:** `npm --prefix backend test` (`vitest run`)
- **Run Locally:** `npm --prefix backend start` (`node dist/index.js`)

---

## 2. Baseline Build and Test Commands (Untouched Code)

### Backend Build
```
> btc-volatility-desk-backend@1.0.0 build
> tsc
(Exited with code 0)
```

### Frontend Build
```
> frontend@0.0.0 build
> tsc && vite build

vite v8.3.4 building client environment for production...
transforming...
✓ 67 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html  3,682.54 kB │ gzip: 1,092.28 kB
✓ built in 1.75s
(Exited with code 0)
```

### Backend Test Run
```
> btc-volatility-desk-backend@1.0.0 test
> vitest run

Test Files  1 failed | 75 passed (76)
     Tests  840 passed | 18 skipped (858)
  Duration  61.68s

FAIL src/routes/password-reset.test.ts [ src/routes/password-reset.test.ts ]
Error: Hook timed out in 10000ms.
(75 test suites and 840 individual tests passed successfully; 1 hook timeout in password-reset.test.ts due to test DB connection).
```

---

## 3. Requirements Audit: Items 5 to 29

| Item | Requirement Summary | Status | Current Real File Path & Function / Symbol |
|---|---|---|---|
| **5** | Read-only P&L tick-by-tick in analysis | **Partial / Missing Backend** | `frontend/index.html` (`vLivePnlTick` lines 3857791+, `pollDeltaPositions()`). Backend `pnl_ticks` table and persistent background recorder **do not exist**. |
| **6** | Floating P&L Greek-wise bifurcation | **Partial** | `frontend/index.html` (`vLivePnlTick` -> `updateFloatingPnl()`, `calcNetGreeks()`). Shows Net Greek levels ($\Delta, \Theta, \nu, \text{IV}$), but dollar attribution split ($\Theta$ PnL, $\Delta+\Gamma$ PnL, $\nu$ PnL, Other PnL) between ticks **does not exist** (was in legacy `v105_18` `step(a, b)`). |
| **7** | Bot trading net P&L wrong | **Confirmed Bug** | `backend/src/routes/bot.ts` (lines 285 & 297 hardcode `fees: 0`), `backend/src/services/bot/bot-engine.ts` (line 560 `gross - run.feesEntry - exec.fees` lacks tax/GST), `backend/src/lib/bot/pnl-analysis.ts`. |
| **10** | Stale read Delta ("no fresh read delta since") | **Confirmed Bug** | `frontend/index.html` (script `v100` -> `dget()`, `v105_18` lines 2097599-2098757 checking `Date.now() - A.at < 150e3`), `backend/src/routes/delta.ts` (`GET /signed`). |
| **11** | Multi-instrument switch (BTC/ETH/AXUSD) | **Does not exist** | Hardcoded exclusively to BTC across all components (`.DEXBTUSD`, `C-BTC-...`, `P-BTC-...`). Multi-instrument state & switcher **do not exist**. |
| **12** | Statistical short strangle condition | **Partial** | `frontend/data/rulebook.js`, `frontend/index.html` (`v105` `gates()`), `backend/src/lib/score.ts`. Standalone 0–100 Strangle Suitability Score **does not exist**. |
| **13** | Go Gauge: live leg delta, gamma, IV skew | **Partial** | `frontend/index.html` (script `v147`, `W.__STRANGLE_RISKMODEL.gauge`). Does not read live open position leg deltas or delta skew. |
| **14** | Usual fall is not accurate | **Confirmed Issue** | `frontend/index.html` (`v147StrategyNearFri`, `data/n2n_iv_path.js` lines 2530320+). Uses fixed NY night window (19:30–07:30 IST); constant-maturity 1d ATM IV baseline **does not exist**. |
| **15** | Master Arm/Disarm safety button | **Does not exist** | `frontend/index.html` (`vLivePnlTick` has view mode `v_pnl_view_mode`), but a safety order execution interlock for Ask Me / Bot **does not exist**. |
| **16** | IV stagnation diagnostics ("Waiting for") | **Does not exist** | Mentioned in static notes (`v105_18`), but live diagnostic ranking panel **does not exist**. |
| **17** | 24x7 Hourly Shadow Strangle (FX tab) | **Does not exist** | Spawner, synthetic Black-Scholes interpolation, 15m candle velocity tracking, and FX tab visual curves **do not exist**. |
| **18** | Insufficient balance / collateral alarm | **Does not exist** | `/v2/wallet/balances` endpoint is exposed in `backend/src/routes/delta.ts`, but frontend margin threshold monitoring and alarm **do not exist**. |
| **19** | Strike picker: do not log if delta not in 0.10–0.15 | **Needs Update** | `backend/src/lib/bot/strike-picker.ts` (`pickBodyLeg()`), `frontend/index.html` (`askTrade` -> `pickStrikes()`). |
| **20** | Strictly deny trade if 0.10–0.15 delta unavailable | **Confirmed Leakage**| `backend/src/lib/bot/strike-picker.ts` lines 32–42 uses `belowTolerance = 0.035` and `aboveTolerance = 0.02`, permitting 0.065 to 0.17 deltas. |
| **21** | 24x7 Session de-restriction & Usual Fall halves | **Needs Update** | `backend/src/lib/bot/schedule.ts` (`SLOTS`), `backend/src/lib/bot/sessions.ts` (`sessionHours`), `frontend/index.html` (`v147`, `SessCal`). |
| **22** | Chart news all sessions, ATM IV, IV vs clock 24x7 | **Needs Update** | `frontend/index.html` (`events24`, `newsgate`, `v89` clock at 21:00, `dflow`). |
| **23** | P&L analysis misleading data | **Confirmed Bugs** | `backend/src/routes/bot.ts` (`/bot/pnl`, `/bot/pnl/trades`), `backend/src/lib/bot/pnl-analysis.ts`, `frontend/index.html` (`data-block="pnl-chart"`, `botPage`). |
| **24** | Best indicator 24x7 | **Needs Update** | `frontend/index.html` (`data/entry_times.js`, `v105_18`, `v147`). |
| **25** | Universal theme sync across all panels | **Partial** | `frontend/index.html` (`vLivePnlTick` has `isUniversalLight()`, but older blocks like `v104Lead`, `v105_18` use hardcoded dark hex colors). |
| **26** | Full-screen trade entry & exit alerts | **Does not exist** | Only small corner badge/sound exists in `desk-alarm`. Full-screen modal alert **does not exist**. |
| **27** | Ask Me submission timer & checkmark | **Partial** | `frontend/index.html` (`askTrade`, `askWidget`). Button has no progress timer or disabled spinner during submission. |
| **28** | Local Devanagari Hindi voice assistant | **Does not exist** | Voice assistant module **does not exist**. |
| **29** | Terminal lock gate, tracker, reset approval | **Partial** | Authentication exists in `backend/src/routes/auth.ts`, but pre-render lock gate (`#vTerminalLockGate`), owner tracker (`#pgUserTracker`), reset approvals, and feedback cleaner **do not exist**. |

---

## 4. Database Schema Comparison

### Existing Database Tables & Columns

1. **`users`** (`backend/src/services/auth-store.ts` & `backend/src/db/schema.ts`):
   - Existing columns: `id`, `email`, `password_hash`, `display_name`, `role`, `created_at`, `updated_at`, `password_changed_at`.
   - **Missing columns per Master Plan:** `active_mode`, `last_seen_at`, `can_trade`.

2. **`desk_password_resets`** (`backend/src/services/auth-store.ts`):
   - Existing columns: `id`, `user_id`, `code_hash`, `expires_at`, `used_at`, `created_by`, `created_at`.
   - **Differences from Master Plan:** Master plan specifies `status varchar(30) DEFAULT 'pending_owner_approval'`, `requested_at`, `decided_at`, `decided_by`, `token_hash`, `expires_at`.

3. **`bot_runs`** (`backend/src/services/bot/bot-store.ts`):
   - Existing columns: `id`, `run_key`, `strategy`, `book`, `mode`, `date_key`, `status`, `entry_at`, `exit_at`, `planned_exit_at`, `spot_entry`, `margin_usd`, `fees_entry`, `fees_exit`, `gross_pnl`, `net_pnl`, `peak_pnl`, `trough_pnl`, `exit_reason`, `exit_detail`, `exit_config`, `tags`, `created_at`.
   - **Missing columns per Master Plan v2 (§6.5):** `entry_fee`, `exit_fee`, `fee_tax`, `pnl_source`, `reconciled`, `reconciled_at` (Note: existing has plural `fees_entry`, `fees_exit`).

4. **Existing Auxiliary Tables** (already in database):
   - `desk_invites`, `desk_delta_keys`, `desk_delta_trade_keys`, `desk_watch_settings`, `desk_watch_events`, `bot_legs`, `bot_fills`, `bot_minute_marks`, `bot_minute_context`, `bot_events`, `bot_config`, `bot_params`, `bot_learning`, `bot_shadow_marks`, `paper_account`, `paper_orders`, `paper_positions`, `paper_fills`, `paper_strategies`, `paper_strategy_legs`.

5. **Tables in Master Plan that Currently DO NOT EXIST:**
   - **`desk_admin_audit`** (Master Plan §4) — *Does not exist*.
   - **`desk_feedback`** (Master Plan §4) — *Does not exist*.
   - **`fills`** (Master Plan §6.5) — *Does not exist*.
   - **`pnl_ticks`** (Master Plan §6.2) — *Does not exist*.
   - **`shadow_cohorts`** (Master Plan §8.8) — *Does not exist*.
   - **`shadow_candles`** (Master Plan §8.8) — *Does not exist*.
   - **`iv_snapshots`** (Master Plan §9.2) — *Does not exist*.

---

## 5. Location of Key System Components

1. **Strike Picker:**
   - Backend: `backend/src/lib/bot/strike-picker.ts` (`pickBodyLeg()`, `pickAtmStraddle()`).
   - Frontend: `frontend/index.html` (script `id="askTrade"`, function `pickStrikes()`, lines 3712788+).
2. **`askTrade`:**
   - Frontend: `frontend/index.html` (script `id="askTrade"`, line 3712788).
3. **Floating P&L Widget:**
   - Active Live Widget: `frontend/index.html` (script `data-module="vLivePnlTick"`, `updateFloatingPnl()`, lines 3857791+).
   - Legacy Widget HTML/CSS: `#v18Float` (lines 2064722+).
4. **P&L Analysis Page:**
   - Frontend DOM container: `ensurePnlHost()` mounting section `id="pgPnl"` (lines 3858000+).
   - Frontend Chart renderer: `frontend/index.html` (script `data-block="pnl-chart"`, line 3361651).
   - Backend API: `backend/src/routes/bot.ts` (`GET /api/v1/bot/pnl`, `GET /api/v1/bot/runs/:id/pnl`, `GET /api/v1/bot/pnl/trades`).
5. **Time Locks (`1:30`, `01:30`, `7:00`, `07:00`, `21:00`):**
   - `1:30` / `01:30`:
     - `backend/src/lib/bot/sessions.ts` (line 34: NY session EDT close 01:30 IST).
     - `frontend/index.html`: `SessCal` EDT close 01:30; `v105_23Side` lines 2591000+ (Entry window 22:30–01:30 IST); `PROVEN_BOUNDARIES.SETUP_START_MINS` (21:30–01:30).
   - `7:00` / `07:00`:
     - `backend/src/lib/bot/schedule.ts` (line 29: `NY_SHORT.exitMin = 24*60 + 7*60` = 07:00 IST).
     - `frontend/index.html`: lines 2530000+ (`data/n2n_iv_path.js` NY open to 07:00 IST lock); line 2821331+ (`v147` Day coach rolls at 07:00 IST).
   - `21:00`:
     - `frontend/index.html`: script `data-block="10_newsiv"`, script `v89` (Tonight IV vs Clock hardcoded to 21:00–07:00 IST), line 2530000+.
6. **Polling Loops and Intervals:**
   - `frontend/index.html`:
     - `vLivePnlTick`: `pollDeltaPositions` (2s), `pollDeltaTickers` (4s), `pollDeltaFills` (6s), `setInterval(pollAll, 2000)`.
     - `v100`: `setInterval(poll, 30000)` (30s).
     - `v105_18`: `setInterval(tick, 60000)` (60s).
     - `v89` / clock / liveRv: `setInterval(liveRv, 2000)` (2s).
   - `backend/src`:
     - `delta-market-worker.ts`: 5000 ms.
     - `deribit-flow-worker.ts`: 30000 ms.
     - `macro-stress-worker.ts`: 60000 ms.
     - `bot-engine.ts`: 5000 ms.
7. **Separate Theme Toggles:**
   - Primary: `frontend/index.html` `#themeBtn` (`id="themeBtn"`).
   - Secondary: `frontend/index.html` `#moreTheme` (`id="moreTheme"` in More popup).
   - Isolated CSS styles: `#v147StrategyNearFri`, `#v104Lead`, `#v105_18` use hardcoded dark hex backgrounds (`#0B141C`, `#111C27`).
8. **Ask Me Order Flow:**
   - Frontend: `frontend/index.html` `askTrade` (`entry` -> `parsePatch` -> `ok` -> `runExecutionPipeline`).
   - Network dispatch: POST to `/api/v1/algo/run` (or `/api/v1/paper/orders` in paper mode).
   - Backend execution: `backend/src/routes/algo.ts` verifies token and calls `services/algo/live-entry.ts`.

---

## 6. Audit of Item 23: The Seven P&L Analysis Checks

| # | Check Description | Status | Evidence (File, Line, or Data) |
|---|---|---|---|
| **1** | Paper, live-read and live-trade rows mixed in one total | **Confirmed Bug** | `backend/src/routes/bot.ts` line 70: `WHERE status = 'closed' AND net_pnl IS NOT NULL AND book <> 'gated'` aggregates all runs regardless of `mode = 'paper'` or `mode = 'live'`. |
| **2** | Realized and unrealized counted twice for closed positions | **Confirmed Bug** | `backend/src/routes/bot.ts` lines 77–79: `openPnl` is added directly to `today` sum. If a run closed today and still lingers in active engine cache, its P&L is counted in both closed sum and open sum. |
| **3** | Missing fees (gross shown as net) | **Confirmed Bug** | `backend/src/routes/bot.ts` lines 285 & 297: `net: Number(x.net_pnl), gross: Number(x.net_pnl), fees: 0` explicitly hardcodes `fees: 0` and sets `gross` equal to `net`. |
| **4** | Timezone and day-boundary errors | **Confirmed Bug** | `backend/src/routes/bot.ts` lines 215 & 298: formats `dateKey` via `new Date(...).toISOString().slice(0, 10)` (UTC midnight). UTC midnight occurs at 05:30 AM IST, splitting late night sessions across two separate calendar days. |
| **5** | Positions still open included in win-rate | **Confirmed Bug** | `frontend/index.html` `groupFillsToTrades`: fills are grouped by expiry date; when computing stats in `pnlChartModule`, trades with `open: true` are not strictly excluded before evaluating `pnl > 0`. |
| **6** | Currency mix (USD vs INR) without a label | **Confirmed Bug** | `frontend/index.html` line 3361665: `const usd = (v, d) => ...` formats all numbers with a `$` symbol indiscriminately, even when fees or wallet balances are reported in INR or USDT. |
| **7** | Rows logged outside 0.10–0.15 delta polluting stats | **Confirmed Bug** | `backend/src/lib/bot/strike-picker.ts` lines 32–42: `belowTolerance = 0.035` and `aboveTolerance = 0.02` allowed 0.065–0.17 delta strikes to be executed and logged into `bot_runs`. |

---

## 7. Audit of Item 7: Current Bot Net P&L Calculation

### Exact Code Computing Bot Net P&L Today

1. **Closed Runs Execution (`backend/src/services/bot/bot-engine.ts`, lines 556–561):**
```ts
let gross = 0;
for (let i = 0; i < run.legs.length; i++) {
  const leg = run.legs[i]!;
  const px = exec.fills[i]!.avgPrice;
  gross += (leg.side === 'short' ? leg.entryPrice - px : px - leg.entryPrice) * leg.lots * CONTRACT_VALUE;
  await setLegExit(run.id, leg.symbol, px);
  const f = exec.fills[i]!;
  await insertFill(run.id, { legSymbol: f.symbol, action: 'exit', side: f.side, lots: f.lots, intendedPrice: f.intendedPrice, avgPrice: f.avgPrice, filled: f.filled, partial: f.partial, fee: f.fee });
}
const net = gross - run.feesEntry - exec.fees;
await closeRun(run.id, { exitAtMs: now, grossPnl: gross, netPnl: net, feesExit: exec.fees, reason, detail });
```

2. **Live Minute Marks (`backend/src/services/bot/bot-engine.ts`, line 584):**
```ts
const snap = { legs: run.legs, marks, spot: chain.spot, marginUsd: run.marginUsd, contractValue: CONTRACT_VALUE, feesPaidUsd: run.feesEntry };
const pnl = computePnl(snap);
await upsertMark({
  runId: run.id, minuteMs: minute, netPnl: pnl.netPnl, grossPnl: pnl.grossPnl, pctMargin: pnl.pctOfMargin, spot: chain.spot, ...
});
```

3. **API Reporting Routes (`backend/src/routes/bot.ts`, lines 285 & 297):**
```ts
// algo_runs
trades.push({ ... net: Number(x.net_pnl), gross: Number(x.net_pnl), fees: 0 });
// real_runs
trades.push({ ... net: Number(x.net_pnl), gross: Number(x.net_pnl), fees: 0 });
```

### Matching Likely Causes in Master Plan v2 (§6.3)
- **Matches Cause 1 (Marks vs Fills):** In `backend/src/routes/bot.ts`, `algo_runs` and `real_runs` fallback to `algo_run_marks.net` (mark-based estimates) instead of exchange `/fills`.
- **Matches Cause 2 (Missing Exit Fee):** In `backend/src/routes/bot.ts` lines 285 & 297, `fees` is hardcoded to `0` for all algo and real runs.
- **Matches Cause 3 (Missing GST/Tax on Fees):** `bot-engine.ts` subtracts `run.feesEntry` and `exec.fees`, but completely ignores exchange transaction tax / GST (`fee_tax`).
- **Matches Cause 4 (Realized vs Unrealized Double Counting):** In `/bot/pnl`, `openPnl` is added alongside `today` sum without checking if a run closed during the same cycle.
- **Matches Cause 5 (Partial Fills):** `paperExecute` in `bot-engine.ts` assumes full fills or aborts; partial fill reconciliation with the exchange ledger does not exist.

