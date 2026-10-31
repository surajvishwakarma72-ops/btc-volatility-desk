# Strangle Pulse Phase 2: Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute every section 5 metric per cohort and per 15-minute step from stored data, each verified against a hand calculation.

**Architecture:** Pure functions in `backend/src/lib/pulse/metrics/`, computed on read from stored rows, so a formula change never needs a data migration. One collector addition: skew and term structure need chain data the collector does not keep, so each grid stores a small per-slot market row.

**Tech Stack:** TypeScript, Vitest, PGlite for store tests.

**Spec:** `docs/superpowers/specs/2026-10-31-strangle-pulse-brief.md` section 5, and `docs/superpowers/specs/2026-10-31-strangle-pulse-design.md`.

## Global Constraints
- Read-only: nothing in `pulse/` may place an order. The existing scan test must keep passing and must cover new files.
- Every threshold lives in `backend/src/lib/pulse/config.ts`, in a new `METRIC_CONFIG` export.
- Metrics use only rows with `data_ok=true`. Any metric whose inputs are missing or would divide by zero returns `null`, never `0`, `NaN` or `Infinity`.
- Time comes from `sampled_ms`, never `grid_ms`. Elapsed days = ms / 86_400_000.
- Stored IV is in vol points (37.5), so IV as a fraction = iv / 100.
- Premium inputs for decay and balance are mids: `call_mid`/`put_mid` at entry and row `mid` now (like-for-like; bid-to-ask would count the spread as adverse decay). Bid and ask are used only for spread and exit cost.
- Stored delta is absolute. Signed net delta is the stored `net_delta` (call minus put).
- Speed is change per 15 minutes: `(now - prev) / (elapsedMinutes / 15)`, null without a previous usable step or with zero elapsed time.
- Commits: stage only named files; end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus
1. First step of a cohort has no previous row: DSI, speeds and OI class are null, not zero (Task 5).
2. BTC barely moves in a step: DSI is null rather than a huge number that reads as fragile (Task 2).
3. Gap in snapshots: speed uses real elapsed time, so a 30-minute step is not read as twice as fast (Task 5).
4. A `data_ok=false` row in the middle of a series is skipped and the next step compares with the last good row (Task 5).
5. No strike near 25 delta, or fewer than two slots at a grid: skew and term are null, not a false inversion (Task 4).

---

### Task 1: Premium metrics

**Files:**
- Modify: `backend/src/lib/pulse/config.ts`
- Create: `backend/src/lib/pulse/metrics/premium.ts`
- Test: `backend/src/lib/pulse/metrics/premium.test.ts`

**Interfaces:**
- Produces:
  - `METRIC_CONFIG = { heavyLegGap: 0.1, minMovePct: 0.02, lastHourSteps: 4, nearDeltaBand: 0.05, sessionMinSamples: 10, volumeConfirmsOi: true }`
  - `decayEfficiency(entryMid: number | null, nowMid: number | null, thetaEntry: number | null, elapsedDays: number): number | null`
  - `balanceDrift(cEntry, pEntry, cNow, pNow: number | null): number | null`
  - `heavyLeg(cEntry, pEntry, cNow, pNow: number | null): 'call' | 'put' | null`: the leg with the higher now/entry ratio, when the ratios differ by at least `heavyLegGap`
  - `ivChange(now: number | null, base: number | null): number | null`
  - `expectedMove(spot: number | null, ivPoints: number | null, elapsedDays: number): number | null`
  - `rangeRatio(spots: readonly number[], expected: number | null): number | null`, (max - min) / expected

- [ ] **Step 1: Write failing tests:**

```ts
expect(decayEfficiency(100, 70, -240, 0.25)).toBeCloseTo(0.5, 6);
expect(decayEfficiency(100, 70, 0, 0.25)).toBeNull();
expect(decayEfficiency(100, 70, -240, 0)).toBeNull();
expect(balanceDrift(100, 100, 200, 100)).toBeCloseTo(0.693147, 6);
expect(balanceDrift(100, 100, 0, 100)).toBeNull();
expect(heavyLeg(100, 100, 120, 80)).toBe('call');
expect(heavyLeg(100, 100, 90, 85)).toBeNull();
expect(heavyLeg(100, 100, 70, 90)).toBe('put');
expect(expectedMove(100000, 50, 36.5)).toBeCloseTo(15811.388, 2);
expect(rangeRatio([100000, 103000, 97094.3], 11811.4)).toBeCloseTo(0.5, 3);
expect(rangeRatio([100000], null)).toBeNull();
```

- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/metrics` in `backend/`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement. `|theta|` guards zero; `ln` guards non-positive premiums.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit with the brief and this plan: `feat(pulse): add premium metrics`. Include `docs/superpowers/specs/2026-10-31-strangle-pulse-brief.md` and this plan.

### Task 2: Leg metrics

**Files:**
- Create: `backend/src/lib/pulse/metrics/legs.ts`
- Test: `backend/src/lib/pulse/metrics/legs.test.ts`

**Interfaces:**
- Consumes: `METRIC_CONFIG`.
- Produces:
  - `dsi(dCallDelta, dPutDelta, spotPrev, spotNow: number | null): number | null`, null when the absolute move in percent is below `minMovePct`
  - `type OiSignal = 'short_buildup' | 'long_unwinding' | 'long_buildup' | 'short_covering' | 'unconfirmed' | null`
  - `oiSignal(premiumChange, oiChange, volumeChange: number | null): OiSignal`
  - `spreadPct(bid, ask, mid: number | null): number | null`
  - `exitCostPct(callAsk, putAsk, callMid, putMid, callBid, putBid: number | null): number | null`: `((callAsk - callMid) + (putAsk - putMid)) / (entry callBid + putBid)`. See the design ruling below.
  - `median(values: readonly number[]): number | null`
  - `liquidityBand(exitCost: number | null): 'normal' | 'penalty' | 'veto' | null`: below 0.05, 0.05 to 0.10, above 0.10
  - `spreadVeto(spread: number | null, median24h: number | null): boolean`: true above 0.10 or above 2 x median; a null spread is false, because NO DATA handles it

**Design ruling:** the brief's "cost to buy both legs back at ask / premium collected" read literally is near 100% at entry and could never sit under 5%, so the thresholds show it means the cost above fair value. Exit cost is the ask-over-mid of both legs divided by premium collected.

- [ ] **Step 1: Write failing tests:**

```ts
expect(dsi(0.02, -0.01, 100000, 101000)).toBeCloseTo(0.03, 6);
expect(dsi(0.02, 0.01, 100000, 100010)).toBeNull(); // 0.01% move, below minMovePct
expect(dsi(null, 0.01, 100000, 101000)).toBeNull();
expect(oiSignal(-5, 100, 2)).toBe('short_buildup');
expect(oiSignal(-5, -100, 2)).toBe('long_unwinding');
expect(oiSignal(5, 100, 2)).toBe('long_buildup');
expect(oiSignal(5, -100, 2)).toBe('short_covering');
expect(oiSignal(5, 100, 0)).toBe('unconfirmed');
expect(oiSignal(5, 100, null)).toBe('unconfirmed');
expect(oiSignal(5, null, 2)).toBeNull();
expect(oiSignal(0, 100, 2)).toBeNull();
expect(spreadPct(90, 110, 100)).toBeCloseTo(0.2, 6);
expect(exitCostPct(110, 55, 100, 50, 200, 100)).toBeCloseTo(0.05, 6);
expect(median([3, 1, 2])).toBe(2);
expect(median([1, 2, 3, 4])).toBe(2.5);
expect(median([])).toBeNull();
expect(liquidityBand(0.049)).toBe('normal');
expect(liquidityBand(0.05)).toBe('penalty');
expect(liquidityBand(0.1)).toBe('penalty');
expect(liquidityBand(0.101)).toBe('veto');
expect(spreadVeto(0.11, null)).toBe(true);
expect(spreadVeto(0.05, 0.02)).toBe(true);
expect(spreadVeto(0.04, 0.02)).toBe(false);
expect(spreadVeto(null, 0.02)).toBe(false);
```

- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/metrics/legs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. With `METRIC_CONFIG.volumeConfirmsOi` false, `oiSignal` skips the volume check; this is the switch for rolling volume.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(pulse): add leg metrics`.

### Task 3: Futures probe and session baseline

**Files:**
- Create: `backend/src/lib/pulse/metrics/tape.ts`
- Test: `backend/src/lib/pulse/metrics/tape.test.ts`

**Interfaces:**
- Consumes: `median`, `METRIC_CONFIG`, `sessionAt` from `backend/src/lib/bot/sessions.ts`.
- Produces:
  - `winnerSide(longPnl, shortPnl: number | null): 'long' | 'short' | null`, null on a tie
  - `winnerPersistence(winners: readonly ('long' | 'short' | null)[]): { side: 'long' | 'short'; count: number } | null`, over the newest 6; winners are newest first; ties in count return null
  - `breakevens(callStrike, putStrike, credit: number | null): { up: number; down: number } | null`
  - `moveVsBreakeven(spotEntry: number | null, futPrices: readonly number[], futEntry: number | null, be: { up: number; down: number } | null): number | null`: largest absolute futures move from `futEntry`, divided by the smaller of `be.up - spotEntry` and `spotEntry - be.down`
  - `efficiencyRatio(prices: readonly number[]): number | null`
  - `sessionBaseline(history: readonly number[], current: number | null): { median: number; ratio: number } | null`: ratio = current / median; null under `sessionMinSamples` samples or a non-positive median

- [ ] **Step 1: Write failing tests:**

```ts
expect(winnerSide(5, -2)).toBe('long');
expect(winnerSide(1, 1)).toBeNull();
expect(winnerPersistence(['long','long','short','long','long','long','short'])).toEqual({ side: 'long', count: 5 });
expect(winnerPersistence(['long','short','long','short','long','short'])).toBeNull();
expect(winnerPersistence([])).toBeNull();
expect(breakevens(105000, 95000, 1000)).toEqual({ up: 106000, down: 94000 });
expect(moveVsBreakeven(100000, [100500, 96400, 101000], 100000, { up: 106000, down: 94000 })).toBeCloseTo(0.6, 6);
expect(efficiencyRatio([100, 110, 100, 120])).toBeCloseTo(0.5, 6);
expect(efficiencyRatio([100, 100, 100])).toBeNull();
expect(efficiencyRatio([100])).toBeNull();
expect(sessionBaseline([1,1,1,1,2,2,2,2,2,2], 1)).toEqual({ median: 2, ratio: 0.5 });
expect(sessionBaseline([1,2,3], 2)).toBeNull();
```

- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/metrics/tape.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Credit is `call_bid + put_bid`, passed in by the caller.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(pulse): add futures probe and session baseline`.

### Task 4: Skew and term structure, collected per grid

**Files:**
- Create: `backend/src/lib/pulse/metrics/market.ts`
- Test: `backend/src/lib/pulse/metrics/market.test.ts`
- Modify: `backend/src/services/pulse/pulse-store.ts`, `backend/src/services/pulse/pulse-store.test.ts`, `backend/src/services/pulse/pulse-engine.ts`, `backend/src/services/pulse/pulse-engine.test.ts`

**Interfaces:**
- Consumes: `ChainOption`, `Slot`, `METRIC_CONFIG.nearDeltaBand`.
- Produces:
  - `interface MarketRow { grid_ms: number; slot: Slot; expiry_ms: number; sampled_ms: number; spot: number; atm_iv: number | null; call25_iv: number | null; put25_iv: number | null; rr25: number | null }`
  - `marketRow(chain, slot, expiryMs, spot, gridMs, nowMs): MarketRow`. ATM: the strike nearest spot with both sides quoted, mean of the two IVs. 25-delta: the option nearest 0.25 delta, only within `nearDeltaBand`. `rr25 = call25_iv - put25_iv`. Non-finite or non-positive IV counts as missing.
  - `termInverted(currentAtm, nextAtm: number | null): boolean | null`, true when current exceeds next
  - Table `pulse_market_snapshots`, `PRIMARY KEY (grid_ms, slot)`; `insertMarketRows(rows)` (`ON CONFLICT DO NOTHING`); `marketRowsAt(gridMs): Promise<MarketRow[]>`

- [ ] **Step 1: Write failing tests:**

```ts
// pure, chain at spot 100000 with an ATM pair at IV 50 and 52, call 0.24 delta IV 48, put 0.26 delta IV 53
expect(row.atm_iv).toBeCloseTo(51, 6);
expect(row.rr25).toBeCloseTo(-5, 6);
it('leaves 25-delta null when nothing is within the band', ...); // nearest 0.15: call25_iv and rr25 null
it('treats NaN IV as missing', ...);
expect(termInverted(55, 50)).toBe(true);
expect(termInverted(50, 55)).toBe(false);
expect(termInverted(null, 50)).toBeNull();
// store (PGlite): insert twice stores one row per (grid_ms, slot); marketRowsAt returns numbers
// engine: a grid tick writes one row per resolved slot; a stale or CHAIN_INCOMPLETE tick writes none; a failed market write does not stop leg snapshots and is retried on the next tick of that grid
```

- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/metrics/market.test.ts src/services/pulse`. Expected: FAIL.
- [ ] **Step 3:** Implement. In the engine, write market rows in the snapshot step for the current grid, once per grid, independent of whether any cohort is live.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(pulse): collect skew and term structure each grid`.

### Task 5: Cohort metric series and read route

**Files:**
- Create: `backend/src/lib/pulse/metrics/series.ts`
- Test: `backend/src/lib/pulse/metrics/series.test.ts`
- Modify: `backend/src/services/pulse/pulse-store.ts`, `backend/src/services/pulse/pulse-store.test.ts`, `backend/src/routes/pulse.ts`, and its test file
- Modify: the order-module scan test in `pulse-engine.test.ts` to include `lib/pulse/metrics`

**Interfaces:**
- Consumes: all functions above; `PulseCohort`, `LegRow`.
- Produces:
  - `interface CohortRow { grid_ms: number; sampled_ms: number; spot: number; fut_price: number; net_delta: number | null; fut_long_pnl: number | null; fut_short_pnl: number | null; data_ok: boolean; call: LegRow; put: LegRow }`
  - `interface StepMetrics { grid_ms: number; sampled_ms: number; minutes_since_entry: number; de_call; de_put; balance_drift; heavy_leg; dsi; net_delta; iv_call_since_entry; iv_put_since_entry; iv_call_1h; iv_put_1h; expected_move; range_ratio; oi_call; oi_put; spread_call; spread_put; spread_median_call; spread_median_put; spread_veto: boolean; exit_cost; liquidity; move_vs_breakeven; efficiency_ratio; speed: Record<string, number | null> }`; numeric fields are `number | null`
  - `metricSeries(cohort: PulseCohort, rows: readonly CohortRow[]): StepMetrics[]`, one entry per `data_ok` row, oldest first
  - `speed` keys: `de_call`, `de_put`, `balance_drift`, `dsi`, `net_delta`, `iv_call_since_entry`, `iv_put_since_entry`, `range_ratio`, `exit_cost`, `spread_call`, `spread_put`, `move_vs_breakeven`, `efficiency_ratio`
  - Store: `cohortRows(cohortId): Promise<CohortRow[]>`, oldest first; `recentCohorts(slot, limit): Promise<PulseCohort[]>`, newest first and any status
  - `GET /api/v1/pulse/metrics?slot=current|next|n2n`, behind `authenticate`: `{ success, slot, cohorts: [{ id, slot_ms, latest: StepMetrics | null }], persistence, skew: { rr25, atm_iv }, term_inverted, gex: { available: false } }`

Rules for `metricSeries`:
- The spot series for range starts with `spot_entry`, then each good row's `spot`. Expected move uses `spot_entry` and the mean of entry IVs.
- Previous means the last `data_ok` row; DSI and OI use it. The first good row's previous is null, except OI, whose `oi_change` is stored already.
- OI premium change = this row's leg mid minus the previous good row's, or minus the entry mid on the first row.
- Spread median = median of that leg's spreads over rows in the last 24h up to and including this one.
- IV 1h change compares with the good row `lastHourSteps` rows back, null if fewer exist.
- Heavy leg and the futures fields use the same mids and series.
- Winner persistence in the route: `winnerSide` from each of the slot's newest 6 non-`no_valid_strikes` cohorts' latest good row. Reading any other slot's cohorts here is not needed.
- `term_inverted` uses Current and Next `atm_iv` at the latest stored grid, whichever slot was requested. Session baseline is exposed by Phase 4, which has the history query; `sessionBaseline` is tested here and not called yet.
- GEX: no backend feed exists; report `available: false`.

- [ ] **Step 1: Write failing tests** on a hand-made cohort: spot_entry 100000, call_mid 100, put_mid 100, theta -240 and -240, entry IV 50 and 50, opened at t0, call_bid 95, put_bid 95, strikes 105000 and 95000, futures entry bid and ask 100000.

```ts
// row1 at t0+6h: call mid 70, put mid 85, spot 101000, deltas change +0.02 and -0.01 vs row0 at t0+15m
const m = metricSeries(cohort, rows);
expect(m).toHaveLength(2);
expect(m[1].de_call).toBeCloseTo(0.5, 6);
expect(m[1].de_put).toBeCloseTo(0.25, 6);
expect(m[1].dsi).toBeCloseTo(0.03, 6);
it('first step: dsi and speeds are null', ...);
it('skips a data_ok=false row and compares with the last good row', ...);
it('speed uses real elapsed time across a gap', ...); // value +10 over 30 min gives speed 5
it('move and path use fut_price', ...);
// store: cohortRows pivots two leg rows and one cohort row per grid, oldest first
// route: 401 without a session; 200 with the shape above; bad slot gives 400; empty database gives cohorts: [] and persistence: null
```

Fill remaining values in row0 and row1 so every asserted figure is produced by hand arithmetic in a comment.

- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/metrics/series.test.ts src/services/pulse src/routes`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run` and `npm run build` in `backend/`. Expected: only the known `answer.test.ts` failure; build clean.
- [ ] **Step 5:** Commit: `feat(pulse): add cohort metric series and read route`.

## Coverage check against section 5
Decay, balance and heavy leg, IV trend, expected move: Task 1. DSI, OI table, spread, exit cost: Task 2. Winner persistence, move vs breakeven, efficiency, session baseline: Task 3. Skew and term: Task 4. Net delta drift and speeds: Task 5. GEX: flagged unavailable in Task 5.
