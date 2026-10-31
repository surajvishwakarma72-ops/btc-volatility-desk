# Strangle Pulse Phase 3B: Live Regime Gate (ADX < 25) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, read-only regime gate on the server using the gate the user chose after the backtest: IV/RV24 > 1.3 AND ADX < 25 AND not the killer pattern AND DVOL < 65. Every input shows its value or is flagged unavailable with a reason.

**Architecture:** A pure evaluator in `backend/src/lib/pulse/regime/gate.ts` (inputs in, per-input readings and a tri-state pass out), an in-memory hourly BTC bar cache fed from Binance's public klines (`services/pulse/hourly-bars.ts`), and a small service plus a `GET /api/v1/pulse/regime` route that wire the existing Task 1 indicators to live DVOL and the macro-stress event feed. Off unless `PULSE_ENABLED=true`.

**Tech Stack:** TypeScript, Fastify, Vitest. Reuses `backend/src/lib/pulse/regime/indicators.ts` (`regimeState`, `hourReturns`, `rvWindow`, `ivOverRv`, `Bar1h`), `deribitWorker.currentDvol`, `macroStressWorker.getSnapshot()`.

**Spec:** `docs/superpowers/specs/2026-10-31-strangle-pulse-brief.md` section 6; `docs/superpowers/specs/2026-10-31-strangle-pulse-design.md`; backtest `docs/superpowers/reports/2026-10-31-regime-gate-backtest.md` (gate id `spec-no-ADX15`, here named `spec-adx25`).

## Global Constraints
- The user chose, after the backtest, the spec gate with the ADX limit changed from 15 to 25. Conditions and strictness are exactly the backtested ones: IV/RV24 **>** 1.3, ADX **<** 25, killer pattern **false**, DVOL **<** 65 (raw DVOL points).
- IV for IV/RV is `DVOL x ivScaleK / 100` with `ivScaleK = 0.8811`, the value the backtest calibrated, so the live gate behaves like the tested one. RV is the 24-hour window, `rvWindow(rets, nowMs, 24)`.
- Only completed hourly bars (open + 1 hour <= now) are used, like the backtest. The browser desk also counts the forming bar, so values may differ slightly from the desk screen; the route says so.
- Read-only: nothing here places orders, and the order-module scan test must cover every new file and keep passing.
- Every threshold in `REGIME_GATE_CONFIG` in `backend/src/lib/pulse/config.ts`.
- A missing, stale or too-short input is unavailable, never a pass. `pass` is `true` only when all four tested inputs are available and ok; `false` when any available tested input fails; otherwise `null`.
- The event blackout is reported but is NOT part of `pass` (it is not backtestable). GEX and large-Deribit-expiry have no feed and are always unavailable with a note.
- Nothing starts unless `PULSE_ENABLED=true`.
- Commits: stage only named files; end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Start this plan only after the Phase 3A backtest fix commit has landed on the branch (it edits files on the same branch).

## Review Focus
1. Binance unreachable or rate-limited at startup: the gate reads unavailable (`pass: null`), never pass, and recovers on a later refresh (Tasks 2, 3).
2. A hole in the hourly bars after downtime: the newest-bar age check makes the bar-based inputs unavailable until backfill fills it (Task 2).
3. The DVOL poll keeps failing silently and `currentDvol` goes stale: DVOL is unavailable after `dvolMaxAgeMs`, not the last value (Tasks 1, 3).
4. A failing tested input plus an unavailable one: `pass` is `false`, not `null`, because the known failure decides (Task 1).
5. Macro feed degraded or still loading: `blackout` is `null`, not `false` (Task 1).

---

### Task 1: Gate evaluator and config

**Files:**
- Modify: `backend/src/lib/pulse/config.ts` (add `REGIME_GATE_CONFIG`)
- Create: `backend/src/lib/pulse/regime/gate.ts`
- Test: `backend/src/lib/pulse/regime/gate.test.ts`

**Interfaces:**
- Consumes: `RegimeState` from `./indicators.js`; `ivOverRv`.
- Produces:
  - `REGIME_GATE_CONFIG = { gateId: 'spec-adx25', ivRvMin: 1.3, adxMax: 25, dvolMax: 65, ivScaleK: 0.8811, rvHours: 24, dvolMaxAgeMs: 600_000, barsMaxAgeMs: 9_000_000, backfillBars: 9500, barsKept: 9300 } as const` (`barsMaxAgeMs` = 2.5 hours)
  - `type InputId = 'iv_rv' | 'adx' | 'killer' | 'dvol' | 'events' | 'gex' | 'deribit_expiry'`
  - `interface InputReading { id: InputId; label: string; value: number | boolean | string | null; threshold: string | null; tested: boolean; available: boolean; ok: boolean | null; note: string }`
  - `interface GateInputs { nowMs: number; dvol: { value: number; at: number } | null; barsNewestOpenMs: number | null; state: RegimeState | null; rv24: number | null; macro: { hasData: boolean; status: 'ok' | 'degraded'; nextEvent: string } | null }`
  - `interface RegimeGateResult { gateId: string; asOf: number; pass: boolean | null; blackout: boolean | null; reasons: string[]; inputs: InputReading[] }`
  - `evaluateRegimeGate(i: GateInputs, cfg?: typeof REGIME_GATE_CONFIG): RegimeGateResult`; inputs in the fixed order `iv_rv, adx, killer, dvol, events, gex, deribit_expiry`

Rules:
- Bar-based inputs (`iv_rv`, `adx`, `killer`) are unavailable when `barsNewestOpenMs` is null or `nowMs - barsNewestOpenMs > barsMaxAgeMs` (note: "hourly bars stale or missing"), or when their own input is null (note says what is missing).
- `dvol` is unavailable when null or `nowMs - at > dvolMaxAgeMs` (note "DVOL older than 10 minutes").
- `iv_rv` value = `ivOverRv(dvol.value * ivScaleK / 100, rv24)`; it needs DVOL too.
- `events`: available only when `macro` is non-null, `hasData` and `status === 'ok'`; `value` = `nextEvent`; `blackout` = `!/^(No Tier-1|loading)/.test(nextEvent)`; `ok` = `!blackout`; `tested: false`.
- `gex` and `deribit_expiry`: `available: false`, `ok: null`, note "no data feed".
- `reasons`: one short line per failing tested input ("ADX 31.2 is not below 25") and per unavailable tested input ("ADX unavailable: hourly bars stale or missing").

- [ ] **Step 1: Write failing tests** (table-driven, with a helper that builds passing inputs: dvol 50 at now, state adx 20, rvpUp false, adxUp false, killer false, rv24 giving IV/RV 1.5):
  - all ok gives `pass: true`, `reasons: []`
  - ADX exactly 25 gives `pass: false` (strict); 24.99 gives true
  - IV/RV exactly 1.3 gives false; 1.31 gives true
  - DVOL exactly 65 gives false; 64.9 gives true
  - `killer: true` gives false; `killer: null` gives `pass: null` and the killer reading unavailable
  - bars newest open 3 hours old: `adx`, `killer`, `iv_rv` unavailable, `pass: null`
  - DVOL 11 minutes old: unavailable, `pass: null`; dvol null: unavailable
  - ADX failing plus DVOL unavailable gives `pass: false` and two reasons
  - `ivOverRv` null (rv24 null) gives iv_rv unavailable
  - macro `nextEvent: 'US CPI Release (in 2h)'` gives `blackout: true` and `pass` unchanged; 'No Tier-1 US news in 6h' gives `blackout: false`; `status: 'degraded'`, `hasData: false` or `macro: null` gives `blackout: null`
  - `gex` and `deribit_expiry` always `available: false`; inputs come in the fixed order
- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/regime/gate.test.ts` in `backend/`. Expected: FAIL.
- [ ] **Step 3:** Implement the evaluator and config.
- [ ] **Step 4:** Run the same command, then `npx tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 5:** Commit with this plan: `feat(pulse): add live regime gate evaluator`.

### Task 2: Hourly bar cache

**Files:**
- Create: `backend/src/services/pulse/hourly-bars.ts`
- Test: `backend/src/services/pulse/hourly-bars.test.ts`

**Interfaces:**
- Consumes: `Bar1h`, `REGIME_GATE_CONFIG`.
- Produces:
  - `parseKlines(raw: unknown): Bar1h[]`: Binance row `[openTimeMs, open, high, low, close, ...]` with string numbers; malformed rows dropped; result sorted ascending
  - `mergeBars(store: Map<number, Bar1h>, incoming: readonly Bar1h[]): void`: a later bar replaces an earlier one with the same open time
  - `interface HourlyBarsDeps { fetchKlines(endTimeMs: number | null, limit: number): Promise<Bar1h[]>; now(): number }`
  - `class HourlyBars { constructor(deps?: Partial<HourlyBarsDeps>); backfill(): Promise<void>; refresh(): Promise<void>; completed(nowMs: number): Bar1h[]; status(): { count: number; newestOpenMs: number | null; lastOkAt: number | null; lastError: string | null }; start(): void; stop(): void }`
  - `hourlyBars` singleton
- Default `fetchKlines` calls `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=<limit>` plus `&endTime=<endTimeMs>` when set, with a 10 s timeout, and throws on a non-200.

Behaviour:
- `backfill()` pages backwards from now (limit 1000 each, `endTime` = oldest open - 1) until `backfillBars` bars are held or a page is empty. It merges as it goes.
- `refresh()` fetches the last 24 bars and merges; if the newest held bar is older than 24 hours (or none is held) it runs `backfill()` instead.
- `completed(nowMs)` returns bars with `t + 3_600_000 <= nowMs`, ascending, at most the newest `barsKept`.
- A failed fetch leaves existing bars untouched, sets `lastError`, and does not throw out of `start()`'s timers. `lastOkAt` updates only on success.
- `start()` runs `backfill()` once in the background, then `refresh()` every hour at 20 seconds past the hour and, while the newest completed bar is not the previous hour's, every 60 seconds until it is. Timers `unref`'d. `stop()` clears them.

- [ ] **Step 1: Write failing tests** with a fake `fetchKlines` and fake clock:
  - `parseKlines` converts strings and drops a row with a NaN or missing field
  - `mergeBars` replaces a forming bar with its final version for the same open time
  - `completed(now)` excludes the bar whose hour has not ended and honours `barsKept`
  - `backfill` pages backwards over three fake pages and stops at the target count; an empty page stops it early
  - fetch failure on refresh: bars unchanged, `lastError` set, `lastOkAt` unchanged
  - refresh when the newest bar is 30 hours old triggers a backfill
  - startup with the fetch failing: `completed()` is empty and `status().lastError` is set (the gate would read unavailable)
- [ ] **Step 2:** Run `npx vitest run src/services/pulse/hourly-bars.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command, then `npx tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 5:** Commit: `feat(pulse): add hourly bar cache for the regime gate`.

### Task 3: Regime service, DVOL timestamp, route and wiring

**Files:**
- Modify: `backend/src/services/deribit-flow-worker.ts` (add `public lastDvolAt: number | null = null;` set to `Date.now()` where `currentDvol` is assigned)
- Create: `backend/src/services/pulse/regime-service.ts`
- Modify: `backend/src/routes/pulse.ts`, `backend/src/services/index.ts` (start/stop `hourlyBars` next to `pulseEngine`, only when `PULSE_ENABLED === 'true'`)
- Test: `backend/src/services/pulse/regime-service.test.ts`, extend `backend/src/routes/pulse.test.ts`, extend the order-module scan in `pulse-engine.test.ts` to include `lib/pulse/regime`

**Interfaces:**
- Consumes: Tasks 1 and 2; `regimeState`, `hourReturns`, `rvWindow` from `indicators.ts`; `deribitWorker`; `macroStressWorker.getSnapshot()`.
- Produces:
  - `interface RegimeDeps { bars: { completed(nowMs: number): Bar1h[]; status(): ReturnType<HourlyBars['status']> }; dvol(): { value: number; at: number } | null; macro(): GateInputs['macro']; now(): number }`
  - `class RegimeService { constructor(deps?: Partial<RegimeDeps>); snapshot(nowMs?: number): RegimeGateResult & { bars: ReturnType<HourlyBars['status']> } }`: caches the result for 60 s per instance; `regimeState(bars, nowMs)` and `rv24 = rvWindow(hourReturns(bars, nowMs), nowMs, rvHours)`; `barsNewestOpenMs` = the newest completed bar's open time, or null when there are none
  - `regimeService` singleton with real deps (DVOL value from `deribitWorker.currentDvol` with `at` from `lastDvolAt`; both must be non-null)
  - `GET /api/v1/pulse/regime`, `{ preHandler: fastify.authenticate }`: `{ success: true, enabled: <PULSE_ENABLED === 'true'>, ...snapshot, gate: { id, ivRvMin, adxMax, dvolMax, ivScaleK, rvHours }, note: 'Uses completed hourly bars only; the desk screen also counts the forming bar, so values can differ slightly.' }`

- [ ] **Step 1: Write failing tests:**
  - **Parity:** build 2,600 deterministic hourly bars (seeded, as in `indicators.test.ts`) and give the service fake deps with fresh DVOL and a calm macro; `snapshot().inputs` ADX value, killer and IV/RV equal direct calls of `regimeState` / `rvWindow` / `ivOverRv` on the same bars.
  - empty bars give `pass: null` and bar-based inputs unavailable
  - bars whose newest open is 3 hours old give `pass: null`
  - DVOL `at` older than `dvolMaxAgeMs` gives dvol unavailable
  - macro blackout string sets `blackout: true` without changing `pass`
  - the result is cached for 60 s and recomputed after
  - route: 401 without a session; 200 with the shape above; with `PULSE_ENABLED` unset it returns `enabled: false` and `pass: null`; the response contains no secret-looking field
  - the order-module scan includes `lib/pulse/regime`, `services/pulse` and `routes/pulse.ts` and still passes
- [ ] **Step 2:** Run `npx vitest run src/services/pulse src/routes/pulse.test.ts src/lib/pulse`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep the `deribit-flow-worker.ts` change to the single field and assignment.
- [ ] **Step 4:** Run `npx vitest run` and `npm run build` in `backend/`. Expected: only the known `answer.test.ts` failure; build clean.
- [ ] **Step 5:** Commit: `feat(pulse): add live regime gate service and route`.

---

## After Part B (not tasks)
Deploy over the live collector only on the user's "deploy". Then read `GET /api/v1/pulse/regime` on the VM and check that every input shows a value, that the bar count is about 9,300 after backfill, and that ADX and IV/RV look sane against the desk screen. Phase 4 combines this gate with the live tape score.

## Known limits to carry
- The backtest of this gate (preliminary numbers): on Next expiry it allowed about 19-25% of hours, cut the stop rate (44% vs 58% in the holdout year), and its holdout per-day average was negative (about -$0.88, error about +/-$0.60). It was a choice made by the user from the numbers. IV there is a flat DVOL proxy, so real results may differ.
- Event blackout and GEX are not backtested.
