# Strangle Pulse Phase 3A: Regime Gate Indicators and Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the desk's regime indicators (ADX, RVP, killer pattern, IV/RV) to a tested server module, then backtest candidate regime gates on 5 years of data so the user can choose the gate from the numbers before Part B builds it live.

**Architecture:** Pure indicator functions in `backend/src/lib/pulse/regime/`, ported from `frontend/index.html` and proven equal to it by parity tests. A backtest script reuses those functions and the existing 5-year strangle simulation approach (`backend/src/backtest/steps/strangle_final_5y.ts`) and writes a markdown report. Nothing in Part A is wired into the live collector.

**Tech Stack:** TypeScript, Vitest, tsx. Cached data: `backend/src/backtest/data/cache/btc-15m-5y.json` (rows `[unixSeconds, o, h, l, c]`) and `btc-dvol-1h-5y.json` (rows `[unixSeconds, dvol]`).

**Spec:** `docs/superpowers/specs/2026-10-31-strangle-pulse-brief.md` section 6 and `docs/superpowers/specs/2026-10-31-strangle-pulse-design.md` (decision 3: backtest, then the user chooses).

## Global Constraints
- Read-only tooling: nothing here places orders or touches the live database. The backtest reads cached files only.
- Indicator definitions come from the browser, which is the desk's current truth: `adxSeries` (index.html ~24721), `returnsOf` (~24456), `rvWindow` (~24466), `dailyRv` (~24480), `dPercentile` (~24370), `regimeCompute` (~24736). Realized vol is a decimal (0.45 = 45%), annualised as `sqrt(sumSq * 8760 / hours)`.
- Thresholds live in a new `REGIME_CONFIG` in `backend/src/lib/pulse/config.ts`: `adxBars: 720`, `adxPeriod: 14`, `adxLookbackBars: 6`, `adxRiseMin: 0.5`, `rvpRiseMin: 0.02`, `rvpDays: 372`, `rvpMinDays: 60`, `minDaysHours: 20`.
- A missing or too-short input returns `null`, never 0 or NaN.
- Gates may use only information available at the entry time (bars and DVOL up to and including the previous complete bar).
- Commits: stage only named files; end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus
1. Fewer than `adxPeriod * 3` bars, or under 60 days of daily RV: ADX and RVP are null, and the gate counts them as unavailable, not as a pass (Task 1).
2. A gap in the hourly bars: returns span the real hours, so a gap does not look like a calm hour (Task 1).
3. Hourly entries are strongly correlated, so a gate's "n" overstates its evidence. The report must give day-clustered errors and a distinct-day count (Task 2).
4. A gate that passes almost never (spec ADX < 15 may) looks good on a handful of lucky trades. The report must flag gates under 120 cohorts per period and never rank them (Task 2).
5. The backtest uses DVOL x K as flat IV, as the other 5-year studies do. The report must say that IV/RV and every P&L figure rest on this proxy (Task 2).

---

### Task 1: Regime indicators (ported, with parity tests)

**Files:**
- Modify: `backend/src/lib/pulse/config.ts` (add `REGIME_CONFIG`)
- Create: `backend/src/lib/pulse/regime/indicators.ts`
- Test: `backend/src/lib/pulse/regime/indicators.test.ts`

**Interfaces:**
- Produces:
  - `interface Bar1h { t: number; o?: number; h: number; l: number; c: number }` (t = bar-open epoch ms)
  - `interface HourReturn { t: number; r: number; h: number }`
  - `hourReturns(bars: readonly Bar1h[], nowMs?: number): HourReturn[]`: log close-to-close; `h` is the real span in hours; when `nowMs` falls inside a bar, that bar's span is shortened as in `returnsOf`
  - `rvWindow(rets: readonly HourReturn[], endT: number, hours: number): number | null`
  - `dailyRv(rets: readonly HourReturn[], nowMs: number): Array<{ day: number; t: number; v: number }>`
  - `percentileBelow(arr: readonly number[], v: number | null): number | null`: fraction strictly below `v`
  - `adxSeries(bars: readonly Bar1h[], n?: number): Array<{ t: number; v: number }> | null`
  - `interface RegimeState { adx: number | null; adxPrev: number | null; adxUp: boolean; rvp: number | null; rvpPrev: number | null; rvpUp: boolean; killer: boolean | null; rv7: number | null }`
  - `regimeState(bars: readonly Bar1h[], nowMs: number): RegimeState | null`: null when the daily history is shorter than `rvpMinDays` or `rv7` is null; `killer` is `rvpUp && adxUp` when both are known, else null
  - `ivOverRv(ivDecimal: number | null, rvDecimal: number | null): number | null`

- [ ] **Step 1: Make the golden values.** In a scratch script outside the repo, extract the browser's `adxSeries`, `returnsOf`, `rvWindow`, `dailyRv`, `dPercentile` and `regimeCompute` bodies and run them on a deterministic synthetic series (400 hourly bars from a seeded sine plus a seeded pseudo-random walk, defined in the test file). Record the outputs listed in Step 2 to 6 decimals.
- [ ] **Step 2: Write failing tests** using those golden numbers as literals:
  - `adxSeries` last three values equal the browser's.
  - `rvWindow(rets, endT, 168)` and `dailyRv(...)` length and last value equal the browser's.
  - `regimeState` fields `adx, adxPrev, rvp, rvpPrev, rvpUp, adxUp` equal `regimeCompute`'s.
  - Analytic cases: 60 strictly rising bars give ADX 100 (assert > 99); an alternating up/down series gives ADX < 10; flat bars give 0; `adxSeries(bars.slice(0, 20))` is null.
  - `percentileBelow([1,2,3,4], 3)` is 0.5; `percentileBelow([], 1)` and `percentileBelow([1], null)` are null.
  - `ivOverRv(0.65, 0.5)` is 1.3 to 6 decimals; `ivOverRv(0.5, 0)` and `ivOverRv(null, 0.5)` are null.
  - A bar series with a 5-hour hole: the return after the hole has `h` equal to 6, not 1.
  - Killer: a fixture where RVP and ADX both rise gives `killer: true`; one rising and one flat gives `false`.
- [ ] **Step 3:** Run `npx vitest run src/lib/pulse/regime` in `backend/`. Expected: FAIL, module not found.
- [ ] **Step 4:** Implement as a faithful port; read thresholds from `REGIME_CONFIG`.
- [ ] **Step 5:** Run the same command, then `npx tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 6:** Commit: `feat(pulse): port regime indicators with browser parity tests`. Include this plan.

### Task 2: Gate comparison backtest

**Files:**
- Create: `backend/src/backtest/steps/regime_gate_compare.ts`
- Create (output, committed): `docs/superpowers/reports/2026-10-31-regime-gate-backtest.md`

**Interfaces:**
- Consumes: Task 1 indicators; the cache files above; `optionFee` (`lib/bot/costs.js`), `portfolioMargin`, `expiriesAfter` (`lib/bot/replay.js`), `bs, roundStrike, strike, yrs` (`backtest/lib/pricing.js`), as `strangle_final_5y.ts` imports them.
- Produces: the markdown report, written by `npx tsx src/backtest/steps/regime_gate_compare.ts`.

Design (all decisions are fixed here):
- **Trade model:** copy the pricing and path logic of `strangle_final_5y.ts` (`pathFor`, `evalVariant`, spread and fee constants; copying matches how the other backtest steps are written). One short strangle per UTC hour at :00, delta 0.125, 100 lots, stop 2x on each leg's entry bid, no take-profit, close at the earlier of the stop and the next 12:00 UTC roll (hold bars = bars until the roll, at most 96). Entries with fewer than 12 bars to the roll are skipped, as in the harness. Run for expiry index 1 (Next) and 2 (N2N).
- **IV proxy:** DVOL x K, calibrated as in the harness, flat. Say so in the report.
- **Periods:** TRAIN 2021-11-30 to 2024-04-25, VALID to 2025-10-25, HOLDOUT to 2026-10-20. Same cut points as `strangle_final_5y.ts`.
- **Indicator inputs at entry time t:** 1h bars built from the 15m cache (open of the first, high max, low min, close of the last 15m bar in the hour) for every bar that ended at or before t; DVOL as of t (null if older than 6h); RV24 = `rvWindow(rets, t, 24)`; RV7 = `rvWindow(rets, t, 168)`; IV = DVOL x K / 100.
- **Gates** (an entry is allowed when the gate passes; unavailable inputs fail the gate):
  1. `none`
  2. `spec`: IV/RV24 > 1.3 AND ADX < 15 AND not killer AND DVOL < 65
  3. `spec-RV7`: same as 2 with IV/RV7
  4. `study`: IV/RV24 > 1.0 AND ADX < 40 AND not killer AND DVOL < 65
  5. `spec-no-ADX15`: IV/RV24 > 1.3 AND ADX < 25 AND not killer AND DVOL < 65
  6. Single rules, for the ablation: `IV/RV24 > 1.3`, `IV/RV24 > 1.0`, `ADX < 15`, `ADX < 25`, `ADX < 40`, `not killer`, `DVOL < 65`
- **Statistics per gate x expiry x period:** cohorts passed; distinct days with at least one pass; % of all hourly entries that pass; mean net P&L per cohort in USD and as % of mean margin; win rate; stop rate; day-clustered standard error of the mean (average each day's P&L first, then the standard error across days); a "THIN" flag when passed cohorts < 120. Also: pass rate by IST weekday, shown separately for Friday evening entries (IST 20:00-23:59, so UTC 14:30-18:29: use UTC hours 15-18); and, for `spec`, how often each of its four conditions is the failing one.
- **Report sections:** headline table (all gates, both expiries, three periods), ablation table, weekday and Friday table, spec-gate failure reasons, limits (flat DVOL x K IV; one 5-year path; event calendar and GEX are not backtestable and are excluded; entries within 3 hours of the roll are skipped), and a plain-language "what this says" paragraph that states tradeoffs without picking a winner: for each gate, fewer trades against stop rate and P&L, including the cost of being selective. Do not recommend a gate.

- [ ] **Step 1:** Write the script and run it with `npx tsx src/backtest/steps/regime_gate_compare.ts` in `backend/`. Expected: it prints progress, finishes, and writes the report. No test file: backtest steps in this repo are verified by their output.
- [ ] **Step 2: Sanity checks, recorded in the report's footer:** the `none` gate's pass rate is 100% of entries that had a valid path; `ADX < 40` passes more entries than `ADX < 25`, which passes more than `ADX < 15` (monotonic); the `none` gate's mean P&L per trade for Next expiry, delta 0.125, stop 2x agrees in sign and rough size with the same rule's line in the output of `strangle_final_5y.ts` (look in `backend/src/backtest/output/` for its report; if none exists, record that this check was skipped); if any check fails, stop and report it instead of publishing the table.
- [ ] **Step 3:** Run `npx tsc --noEmit` and `npm run build`. Expected: clean.
- [ ] **Step 4:** Commit the script and the report: `feat(pulse): add regime gate comparison backtest`.

---

## After Part A (not tasks)
The user reads the report and picks a gate, or a custom mix. Then Part B gets its own plan: a server hourly-bar fetcher and in-memory cache (the server keeps no hourly bars; `binanceWorker` streams 1m), `RegimeService` combining those with `deribitWorker.currentDvol`, ATM IV from the collector, and the macro-stress event feed (`macroStressWorker`, `services/algo/event-guard.ts`), a `GET /api/v1/pulse/regime` route where every input shows a value or `available: false` with a reason, and GEX flagged unavailable. Done when each input shows a value or is clearly flagged unavailable.

## Coverage check
Indicators ADX, RVP, killer pattern, IV/RV: Task 1. DVOL: used in the backtest; live source named for Part B. GEX and event calendar: flagged out of backtest scope, live sourcing in Part B. The user's decision to choose from numbers: Task 2.
