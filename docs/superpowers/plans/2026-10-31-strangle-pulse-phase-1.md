# Strangle Pulse Phase 1: Collector and Cohorts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on, read-only backend service that opens paper strangle and futures cohorts at every HH:30 IST for Current, Next and N2N, snapshots them every 15 minutes, and logs data health.

**Architecture:** Pure logic in `backend/src/lib/pulse/` (grid, cohort rules, P&L). A one-minute engine in `backend/src/services/pulse/` polls public Delta tickers, runs what is due, and persists via raw SQL with idempotent DDL, like `bot-store.ts`. Off unless `PULSE_ENABLED=true`.

**Tech Stack:** TypeScript, Fastify, `pg` pool, Vitest, PGlite for integration tests.

**Spec:** `docs/superpowers/specs/2026-10-31-strangle-pulse-design.md`, plus sections 2-4 of the user's brief (reproduced in Global Constraints).

## Global Constraints
- Read-only: no code in `pulse/` may import or call anything that places an order. Public market data only; no API keys.
- HH:30 IST equals :00 UTC. Cohorts open at the top of every UTC hour, 24/7. Snapshots at :00, :15, :30, :45 UTC.
- Strikes: abs(delta) 0.10-0.15 per leg, closest to 0.125. No tolerance outside the band: `pickBodyLeg(chain, type, expiryMs, SHORT_BAND, 0, 0)`.
- Entry fill at bid (store mid too). Mark and exit at ask. 1 lot per leg. 1 lot long and 1 lot short BTCUSD perp at the same timestamp.
- `SL_HIT` when a leg's ask >= 2 x its entry bid. Sticky, and tracking continues after it.
- Every P&L is net of exchange fees, GST (0.18) and estimated slippage, for entry and estimated exit.
- Every threshold lives in `backend/src/lib/pulse/config.ts`.
- All new routes use `{ preHandler: fastify.authenticate }`.
- Before pushing, `npm run build` must pass as well as tests.
- Commits: stage only named files. `.gitignore` and `.agents/` have unrelated changes.

## Review Focus
1. Server restarts mid-hour: live cohorts resume, and no cohort or snapshot is duplicated (Task 5).
2. Delta is down at HH:30: a late open happens within 5 minutes of the slot, otherwise a `MISSED_OPEN` event and no back-dated cohort (Task 5).
3. A sold leg disappears from the chain or has no ask: the snapshot row is stored with `data_ok=false`, P&L stays null, no false `SL_HIT`, and the cohort stays live (Task 4).
4. Fewer than 3 expiries listed: missing slots are skipped with a `SLOT_MISSING` event and other slots keep running (Task 3).
5. The roll happens during an outage: the first good tick closes affected cohorts with reason `ROLL` at that tick's prices, or last stored prices if the option has gone (Task 5).

---

### Task 1: Config, time grid and expiry slots

**Files:**
- Create: `backend/src/lib/pulse/config.ts`, `backend/src/lib/pulse/grid.ts`
- Test: `backend/src/lib/pulse/grid.test.ts`

**Interfaces:**
- Produces:
  - `PULSE_CONFIG = { snapshotMinutes: 15, lateOpenGraceMs: 300_000, staleQuoteMs: 120_000, stopMultiple: 2, slippagePct: 0.01, lots: 1, oiBandStrikes: 2, futuresSymbol: 'BTCUSD', futuresTakerRate: 0.0005, futuresContractValue: 0.001 }`
  - `type Slot = 'current' | 'next' | 'n2n'`, `SLOTS: readonly Slot[]`
  - `cohortSlotMs(nowMs): number` floors to the UTC hour
  - `snapshotGridMs(nowMs): number` floors to 15 minutes
  - `resolveSlots(expiries: readonly number[]): Partial<Record<Slot, number>>`, index 0, 1, 2 of the sorted list

- [ ] **Step 1: Write failing tests**

```ts
const t = Date.UTC(2026, 9, 31, 0, 7, 12);
expect(cohortSlotMs(t)).toBe(Date.UTC(2026, 9, 31, 0, 0)); // 05:30 IST
expect(snapshotGridMs(Date.UTC(2026, 9, 31, 3, 44, 59))).toBe(Date.UTC(2026, 9, 31, 3, 30));
expect(resolveSlots([3, 1, 2])).toEqual({ current: 1, next: 2, n2n: 3 });
expect(resolveSlots([5])).toEqual({ current: 5 });
```

- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/grid.test.ts` in `backend/`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement both files. `slippagePct` is a fraction of premium and is my estimate.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit with the spec:

```bash
git add docs/superpowers/specs/2026-10-31-strangle-pulse-design.md docs/superpowers/plans/2026-10-31-strangle-pulse-phase-1.md backend/src/lib/pulse/
git commit -m "feat(pulse): add config, time grid and expiry slots"
```

### Task 2: Extend market data

**Files:**
- Modify: `backend/src/lib/bot/strike-picker.ts` (`ChainOption`), `backend/src/services/bot/delta-public.ts`
- Test: add to the existing delta-public test file if one exists, else create `backend/src/services/bot/delta-public.test.ts`

**Interfaces:**
- Produces:
  - `ChainOption` gains optional `oi?: number` (from `oi_contracts`), `volume?: number` (from `volume`) and `quoteTsMs?: number` (`timestamp` is microseconds; divide by 1000)
  - `fetchPerpQuote(symbol = 'BTCUSD'): Promise<{ bid: number; ask: number; mark: number; spot: number; tsMs: number }>`, using `deltaGet('/v2/tickers/' + symbol)`

- [ ] **Step 1: Write failing test** from a live-shaped ticker:

```ts
const p = parseTicker({ symbol: 'C-BTC-78400-021126', contract_type: 'call_options', strike_price: '78400', mark_price: '200.13', greeks: { delta: '0.2457' }, quotes: { best_bid: '198', best_ask: '203', mark_iv: '0.2356' }, oi_contracts: '5629', volume: 13.801, timestamp: 1793439259596683 });
expect(p?.oi).toBe(5629);
expect(p?.volume).toBeCloseTo(13.801);
expect(p?.quoteTsMs).toBe(1793439259596);
```

- [ ] **Step 2:** Run it. Expected: FAIL, `oi` undefined.
- [ ] **Step 3:** Add `oi_contracts?: string`, `volume?: number`, `timestamp?: number` to `DeltaTicker` and map them in `parseTicker`. Floor `quoteTsMs`. Add `fetchPerpQuote`.
- [ ] **Step 4:** Run `npx vitest run` in `backend/`. Expected: all pass, including existing bot tests (the new fields are optional).
- [ ] **Step 5:** Commit: `feat(pulse): read OI, volume and quote time from Delta tickers`.

### Task 3: Cohort rules and P&L (pure)

**Files:**
- Create: `backend/src/lib/pulse/cohort.ts`
- Test: `backend/src/lib/pulse/cohort.test.ts`

**Interfaces:**
- Consumes: `pickBodyLeg`, `SHORT_BAND`, `optionFee`, `futuresFee`, `PULSE_CONFIG`, `Slot`.
- Produces:
  - `type OpenPlan = { kind: 'open'; call: ChainOption; put: ChainOption } | { kind: 'no_valid_strikes'; missing: Array<'call' | 'put'> }`
  - `planOpen(chain, expiryMs): OpenPlan`
  - `legNetPnl(i: { entryBid: number; ask: number; spot: number; fee: FeeRates }): number`, USD for `PULSE_CONFIG.lots`, equal to `(entryBid - ask) * lots * contractValue` minus entry and exit `optionFee` (taker rate, GST default) minus `slippagePct * entryBid * lots * contractValue`
  - `futuresNetPnl(i: { side: 'long' | 'short'; entry: number; exit: number }): number`, gross minus two `futuresFee`
  - `isStopHit(entryBid, ask): boolean`, `ask >= stopMultiple * entryBid`
  - `oiBand(chain, type, expiryMs, strike): number | null`, sum of `oi` over the sold strike +/- `oiBandStrikes` listed strikes of that type and expiry
  - `delta2(now: number | null, prev: number | null): number | null`, change since last snapshot; null when either side is missing or the result is negative for volume (see Step 3)

- [ ] **Step 1: Write failing tests:**

```ts
it('picks the strike closest to 0.125 inside the band', () => { /* deltas 0.09, 0.12, 0.14: expect 0.12 */ });
it('returns no_valid_strikes naming the missing side', () => { /* call deltas only 0.2 */ expect(plan).toEqual({ kind: 'no_valid_strikes', missing: ['call'] }); });
it('legNetPnl matches a hand calculation', () => {
  const fee = { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.001 };
  // gross 0.05; fees (0.007 entry cap + 0.00525 exit cap) * 1.18 = 0.01445; slippage 0.01 * 0.2 = 0.002
  expect(legNetPnl({ entryBid: 200, ask: 150, spot: 77000, fee })).toBeCloseTo(0.03355, 6);
});
it('flags stop exactly at 2x', () => { expect(isStopHit(100, 200)).toBe(true); expect(isStopHit(100, 199.9)).toBe(false); });
it('oiBand sums two listed strikes either side and stops at the chain edge', () => { /* ... */ });
```

- [ ] **Step 2:** Run `npx vitest run src/lib/pulse/cohort.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. `delta2` for OI may be negative; give it a `{ nonNegative?: boolean }` third parameter, set true for volume. A negative volume difference means `volume` is a rolling window, and returning null keeps that from being read as flow.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(pulse): add cohort rules and net P&L`.

### Task 4: Store and snapshot builder

**Files:**
- Create: `backend/src/services/pulse/pulse-store.ts`, `backend/src/lib/pulse/snapshot.ts`
- Test: `backend/src/lib/pulse/snapshot.test.ts`, `backend/src/services/pulse/pulse-store.test.ts` (PGlite, using the `vi.mock('../../db/index.js')` pattern from `bot-engine.test.ts`)

**Interfaces:**
- Produces:
  - DDL via `ensurePulseSchema(): Promise<void>`:
    - `pulse_cohorts`: `id uuid PK`, `slot`, `series_id`, `slot_ms bigint`, `expiry_ms bigint`, `status` (`open | closed | no_valid_strikes`), `opened_at`, `closed_at`, `close_reason` (`ROLL | EXPIRED`), `spot_entry`, `fut_entry_bid`, `fut_entry_ask`, `call_symbol`, `put_symbol`, `call_strike`, `put_strike`, `call_bid`, `put_bid`, `call_mid`, `put_mid`, `call_delta`, `put_delta`, `call_theta`, `put_theta`, `call_iv`, `put_iv`, `fee jsonb`, `missing jsonb`, `call_sl_at`, `put_sl_at`, `net_pnl`. `UNIQUE (slot, slot_ms)`.
    - `pulse_leg_snapshots`: `cohort_id`, `grid_ms bigint`, `leg`, `minutes_since_entry`, `strike`, `expiry_ms`, `bid`, `ask`, `mark`, `mid`, `delta`, `gamma`, `theta`, `vega`, `iv`, `oi`, `oi_band`, `oi_change`, `volume_raw`, `volume_change`, `net_pnl`, `sl_hit bool`, `data_ok bool`. `PRIMARY KEY (cohort_id, grid_ms, leg)`.
    - `pulse_cohort_snapshots`: `cohort_id`, `grid_ms`, `spot`, `fut_price`, `combined_premium`, `combined_pnl`, `pnl_pct`, `net_delta`, `fut_long_pnl`, `fut_short_pnl`, `data_ok`. `PRIMARY KEY (cohort_id, grid_ms)`.
    - `pulse_events`: `id bigserial`, `at`, `type`, `slot`, `detail jsonb`.
  - `insertCohort(c): Promise<boolean>`, using `ON CONFLICT DO NOTHING`; false means it already exists
  - `liveCohorts(): Promise<PulseCohort[]>`
  - `insertSnapshot(s: BuiltSnapshot): Promise<void>`, idempotent, in one multi-row statement per table
  - `lastLegSnapshots(cohortId): Promise<Record<'call' | 'put', LegRow | undefined>>`
  - `markStop(cohortId, leg, atMs)`, `closeCohorts(ids, reason, atMs, netPnl)`, `logEvent(type, slot, detail)`, `dbSizeBytes()`
  - Pure `buildSnapshot(cohort, chain, perp, prev, gridMs, nowMs): BuiltSnapshot`. Signed net delta uses call delta minus put delta from absolute values.

- [ ] **Step 1: Write failing tests:**

```ts
it('stores a missing leg as data_ok=false with null pnl and no stop', () => {
  const s = buildSnapshot(cohort, chainWithoutPut, perp, {}, grid, now);
  expect(s.legs.put).toMatchObject({ data_ok: false, net_pnl: null, sl_hit: false });
  expect(s.cohort.data_ok).toBe(false);
  expect(s.cohort.combined_pnl).toBeNull();
});
it('treats ask=0 as missing, never as a free buyback', () => { /* put ask 0: data_ok false */ });
it('keeps sl_hit once set even after ask falls', () => { /* cohort.put_sl_at set, ask below 2x: sl_hit true */ });
it('pnl_pct is combined P&L over premium collected', () => { /* hand value */ });
// PGlite:
it('insertCohort twice for one slot_ms stores one row', async () => { expect(await insertCohort(c)).toBe(true); expect(await insertCohort(c)).toBe(false); });
it('insertSnapshot twice for one grid stores one set of rows', async () => { /* count 2 legs, 1 cohort row */ });
```

- [ ] **Step 2:** Run both test files. Expected: FAIL.
- [ ] **Step 3:** Implement with raw SQL following `bot-store.ts`. Add an index on `pulse_cohorts (status, slot)` and one on `pulse_events (at)`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(pulse): add storage and snapshot builder`.

### Task 5: Engine, startup and status route

**Files:**
- Create: `backend/src/services/pulse/pulse-engine.ts`, `backend/src/routes/pulse.ts`
- Modify: `backend/src/services/index.ts` (start line after `botEngine`), `backend/src/routes/index.ts` (register under `/pulse`)
- Test: `backend/src/services/pulse/pulse-engine.test.ts` (PGlite; mock `fetchChain`, `fetchPerpQuote`, `fetchOptionFeeRates`; manual ticks with fake Date)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `class PulseEngine` with `get enabled(): boolean` (`process.env.PULSE_ENABLED === 'true'`), `start(): Promise<void>`, `stop(): void`, `tick(nowMs?: number): Promise<void>`, `status(): PulseStatus`
  - `pulseEngine` singleton
  - `GET /api/v1/pulse/status`: `{ enabled, lastTickAt, lastError, dataOk, slots: { current|next|n2n: { expiryMs, live, seriesId } }, dbSizeBytes }`

Tick order, in one sequential flow (a tick is skipped if the previous one is still running):
1. Fetch chain and perp. On failure or a quote older than `staleQuoteMs`: set `dataOk=false`, log `DATA_STALE` once per outage, return.
2. `resolveSlots`. Log `SLOT_MISSING` once per slot per outage.
3. Roll: any live cohort whose `expiry_ms` no longer matches its slot closes (`EXPIRED` if `expiry_ms <= now`, else `ROLL`), and the slot gets a new `series_id`. A cohort's final `net_pnl` uses the current ask, the last stored leg P&L if the symbol is gone, and for `EXPIRED` the intrinsic value against spot.
4. Snapshot: if `snapshotGridMs(now)` differs from the last completed grid, write snapshots for all live cohorts, and set stops via `markStop`. A skipped grid logs `SNAPSHOT_GAP`.
5. Open: for each slot, if `now - cohortSlotMs(now) <= lateOpenGraceMs` and no cohort exists for that `slot_ms`, run `planOpen` and `insertCohort`. Past the grace with none, log `MISSED_OPEN` once.
6. Hourly, log `DB_SIZE`.

Roll runs before open, so the 17:30 IST cohort joins the new series. `start()` restores `lastGrid` from storage. The timer is `setInterval(tick, 60_000)` aligned to the next minute. `fetchOptionFeeRates` is called at open for the chosen symbols.

- [ ] **Step 1: Write failing tests:**

```ts
it('does nothing unless PULSE_ENABLED=true', ...);
it('opens one cohort per slot at 05:30 IST and stores entry at bid', ...);
it('opens 24 per slot across a simulated day of minute ticks, up to the roll', ...);
it('takes 2 leg rows and 1 cohort row per live cohort each 15 minutes', ...);
it('stores NO_VALID_STRIKES as a row and event, then continues', ...);
it('closes all slots on the 12:00 UTC roll, then opens in a new series on the same tick', ...);
it('restart mid-hour: a new engine creates no duplicate cohort or snapshot', ...);
it('API down at HH:30, back 3 minutes later: opens late', ...);
it('API down past 5 minutes: logs MISSED_OPEN, opens nothing for that hour', ...);
it('roll during outage: first good tick closes with ROLL', ...);
it('two expiries listed: logs SLOT_MISSING for n2n, others run', ...);
it('never imports an order module', () => { /* read pulse-engine.ts source; expect no paper-broker, live-entry, brokers, stop-order, delta-keys */ });
```

- [ ] **Step 2:** Run `npx vitest run src/services/pulse`. Expected: FAIL.
- [ ] **Step 3:** Implement the engine, route and wiring (`void pulseEngine.start(); // Strangle Pulse collector; no-op unless PULSE_ENABLED=true`).
- [ ] **Step 4:** Run `npx vitest run` then `npm run build` in `backend/`. Expected: all pass, `tsc` clean.
- [ ] **Step 5:** Commit: `feat(pulse): add collector engine and status route`.

### Task 6: Live smoke check and Phase 1 report

**Files:**
- Create: `backend/src/scripts/pulse-smoke.ts`
- Modify: `.env.prod.example` (add `PULSE_ENABLED=false`)

- [ ] **Step 1:** Write a script that runs one engine tick against live public Delta using an in-memory PGlite store, then prints slots, chosen strikes and deltas, net P&L and row counts. It must not touch Neon.
- [ ] **Step 2:** Run `npx tsx src/scripts/pulse-smoke.ts`. Expected: three slots resolved, or a clear `NO_VALID_STRIKES`; deltas within 0.10-0.15; bids and asks non-zero. Paste the output into the report.
- [ ] **Step 3:** Commit: `chore(pulse): add live smoke script`.
- [ ] **Step 4:** Report Phase 1 per section 11 of the brief. State that the 24-hour criterion is NOT yet met: it needs a "deploy" from the user plus `PULSE_ENABLED=true` on the VM. After that run, check `/pulse/status`, count 24 opens per day, check `SNAPSHOT_GAP` and `MISSED_OPEN` events, check whether `volume_change` shows nulls (rolling volume), and compute storage runway from `DB_SIZE`.
