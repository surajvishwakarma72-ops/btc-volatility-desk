# One-Minute Seller Damage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Short Strangle lane so Risk, Call and Put update each minute from premium damage per BTC move, without changing the live algo.

**Architecture:** The collector saves one row a minute from the chain it already fetches. Pure functions turn those rows into damage, the fast trigger and minute readings. `pulseScore` adds a `minute` block behind a flag; `pulseNow` and the algo condition stay on today's reading.

**Tech Stack:** TypeScript, Fastify, pg (Neon), Vitest, PGlite, one `frontend/index.html`, lightweight-charts 4.1.3.

**Spec:** `docs/superpowers/specs/2026-11-02-pulse-minute-damage-design.md`

## Global Constraints

- The live algo stays on today's Risk until the test passes and the trader approves.
- Strangles open only inside 0.10 to 0.15 delta. The bot's rule does not change.
- Damage scale: 5 reads 0, 30 reads 100. Floor on the BTC move: 0.02%. Weight 30 of 100. Risk uses the worse side.
- Missing data stays missing: never invent a point. No damage reading means WAIT at most.
- Rows older than 45 days are deleted.
- Deploys are run by the trader. Claude cannot change the VM or read the live database.
- Never commit unrelated working-tree changes. Stage only the files each task names.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A premium wobble on a flat market: the score reads 100 through the floor, adds up to 30 Risk, but must not fire the trigger. Tested in Task 2.
- The hourly switch: a change across two positions must never count as damage. Tested in Task 2.
- A collector gap: no row means no point, and a change across the gap is not measured. Tested in Tasks 2 and 5.
- A failed minute write must not stop the 15-minute collector. Tested in Task 3.
- `pulseNow` must return the same reading with the flag on or off. Tested in Task 6.

---

### Task 1: Stage 0, chart fix and old-version cleanup

**Files:**
- Modify: `frontend/index.html` (already edited, uncommitted)
- Modify: `.git/info/exclude` (add `.superpowers/`, so the uncommitted `.gitignore` stays untouched)
- Create: scratchpad `deploy-stage0.sh`

- [ ] **Step 1: Run `node <scratchpad>/parse.cjs frontend/index.html`.** Expected: `done`.
- [ ] **Step 2: Commit `frontend/index.html` and the spec and this plan.** Message: `fix(desk): fit the chart by its own edge, and add the minute damage design`.
- [ ] **Step 3: Write `deploy-stage0.sh` from `deploy-fit.sh`.** Before the build, remove the images `app-app:rollback-e9ed11b`, `app-app:rollback-89624b6` and `app-app:rollback-b7f770f`, keeping `rollback-e664821` and `latest`. Tag the new rollback `rollback-9965151`. Check for `fit.adj` code by grepping the site for `v144.2`.
- [ ] **Step 4: Hand the command to the trader.** After it prints `DEPLOYED`, check health, restarts, error logs and disk over SSH.

### Task 2: Damage and trigger maths

**Files:**
- Create: `backend/src/lib/pulse/metrics/damage.ts`
- Test: `backend/src/lib/pulse/metrics/damage.test.ts`
- Modify: `backend/src/lib/pulse/config.ts`

**Interfaces:**
- Produces: `MinuteRow { t, cohort_id, fut_price, call_mid, put_mid, call_iv, put_iv, data_ok }`; `Entry { call: number; put: number }`
- Produces: `damageAt(now: MinuteRow, rows: readonly MinuteRow[], entry: Entry): SideDamage | null`, with `SideDamage = { call: Side | null; put: Side | null; movePct: number }` and `Side = { premiumUpPct: number; ratio: number; score: number }`
- Produces: `triggerStep(prev: TriggerState, d: SideDamage | null): TriggerState`, with `TriggerState = { above: number; below: number; on: boolean; side: 'call' | 'put' | null }`
- Produces: `DAMAGE_CONFIG = { windowMin: 5, moveFloorPct: 0.02, map: [5, 30], weight: 30, triggerPremiumPct: 10, triggerMinutes: 2, clearMinutes: 10, zoneReadings: 5, futuresWindowMin: 60, futuresMap: [0, 1], lineDamageShare: 0.6, retentionDays: 45 }`

- [ ] **Step 1: Write the failing tests:**

```ts
// premium up 10% of entry for a 2% BTC move: ratio 5, score 0
// premium up 30% of entry for a 1% BTC move: ratio 30, score 100
it('premium falling is zero damage', ...)            // premiumUpPct 0, score 0
it('uses the 0.02% floor on a flat market', ...)     // up 1% on a 0 move: ratio 50, score 100
it('never compares two positions', ...)              // the row 5 min ago has another cohort_id: null
it('is null across a gap', ...)                      // no same-cohort row within 5 min, one minute tolerance
it('a wobble scoring 100 does not fire', ...)        // premiumUpPct 1 for 5 minutes: on false
it('fires after 2 minutes per side', ...)            // score 100 and up 10%: 1 step off, 2 steps on, side 'put'
it('clears after 10 minutes below', ...)             // 9 steps on, 10 steps off
```

- [ ] **Step 2: Run `npx vitest run src/lib/pulse/metrics/damage.test.ts`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** `premiumUpPct = max(0, (mid - mid5) / entry * 100)`, `ratio = premiumUpPct / max(abs(movePct), moveFloorPct)`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** both files and `config.ts`.

### Task 3: Record a row every minute

**Files:**
- Modify: `backend/src/services/pulse/pulse-store.ts` (DDL, `insertMinuteRows`, `minuteRows`, `pruneMinute`)
- Modify: `backend/src/services/pulse/pulse-engine.ts` (`runTick`)
- Create: `backend/src/lib/pulse/minute-plan.ts` and its test
- Test: `backend/src/services/pulse/pulse-engine.test.ts`

**Interfaces:**
- Consumes: `MinuteRow`
- Produces: `minuteTargets(live: readonly PulseCohort[], slot: Slot, now: number): PulseCohort[]`
- Produces: `insertMinuteRows(rows: Array<MinuteRow & { slot: Slot }>): Promise<void>`, `minuteRows(slot: Slot, fromMs: number): Promise<MinuteRow[]>`, `pruneMinute(beforeMs: number): Promise<void>`
- Table: `pulse_minute`, primary key `(slot, cohort_id, t)`, index `(slot, t)`, with `ON CONFLICT DO NOTHING`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('targets the newest strangle on the slot', ...)                 // status 'open', newest slot_ms
it('also targets the previous one for 5 minutes after a switch', ...)
it('never targets futures_only cohorts', ...)
it('saves one row per slot on a healthy tick', ...)
it('saves nothing on a stale tick', ...)
it('a failed minute write leaves the 15-minute snapshot intact', ...) // h.failSql = 'INSERT INTO pulse_minute'
it('deletes rows past 45 days once an hour', ...)
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** In `runTick`, after `this.snapshot(...)`, call a private `recordMinute`, wrapped in its own try/catch that sets `lastError` and logs. Read mids by `c.call_symbol` and `c.put_symbol` from `chain.options`; a missing quote stores null and `data_ok` false. Round `t` down to the minute. Prune inside the hourly `logDbSize` path.
- [ ] **Step 4: Run `npx vitest run src/services/pulse src/lib/pulse`.** Expected: PASS.
- [ ] **Step 5: Commit** the named files.

### Task 4: Stage 1, start recording

**Files:** scratchpad `deploy-stage1.sh`, `minute-check.sh`

- [ ] **Step 1: Run `npx tsc --noEmit -p .` and the whole `src/lib/pulse src/services/pulse src/routes src/lib/algo src/services/algo` test set.** Expected: no type errors, all pass.
- [ ] **Step 2: Package the changed files and write the deploy script,** with `rollback-` tagged to the Stage 0 commit, and the site check still using `v144.2`.
- [ ] **Step 3: Hand the command to the trader,** then verify over SSH.
- [ ] **Step 4: Write `minute-check.sh`,** a read-only count of `pulse_minute` rows per slot and per hour and the largest gap, for the trader to run the next day. Expected: about 60 rows an hour per slot with a strangle.

### Task 5: Minute readings

**Files:**
- Create: `backend/src/lib/pulse/score/minute.ts` and its test

**Interfaces:**
- Consumes: `damageAt`, `triggerStep`, `DAMAGE_CONFIG`, `SCORE_CONFIG.zones`
- Produces: `minuteReadings(rows: readonly MinuteRow[], entries: ReadonlyMap<string, Entry>, base: readonly BasePoint[]): MinutePoint[]`
- `BasePoint = { t, c, call, put }`, which are today's 15-minute points.
- `MinutePoint = { t, r: number | null, z: Zone, call: number | null, put: number | null, fl: number | null, fs: number | null, hurt: 'call' | 'put' | null, trigger: boolean }`

- [ ] **Step 1: Write the failing tests:**

```ts
it('blends 70% of held Risk and 30% of the worse side', ...)       // Risk 40, worse 100: r 58
it('holds a base point for at most 30 minutes', ...)               // then r null, z 'nodata'
it('caps at WAIT with no damage', ...)                             // Risk 10, no damage: z 'caution'
it('needs 5 readings to change zone', ...)                         // 4 stay, 5 change
it('the trigger goes straight to avoid', ...)
it('returns through the normal rule when the trigger clears', ...)
it('Call is 60% damage and 40% the held line', ...)
it('Call is null when its damage is missing', ...)
it('futures read the signed 60-minute move', ...)                  // up 0.5%: fl 50, fs 0
it('makes no point for a missing minute', ...)
it('futures keep reading with no strangle', ...)                   // r null, z 'nodata', fl present
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Measure, at each minute, the newest cohort that has a row 5 minutes earlier. Risk is `100 - c`. Cut-offs are `100 - sellMin` and `100 - cautionMin`. `hurt` is the side with the higher score, only when that score is above 0.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 6: Score block behind a flag

**Files:**
- Modify: `backend/src/services/pulse/pulse-score.ts`
- Test: `backend/src/services/pulse/pulse-score.test.ts`
- Modify: the deploy env file used by `docker-compose.prod.yml`, once its loading is confirmed

**Interfaces:**
- Produces: `/score` gains `minute: MinutePoint[] | null`, filled only when `process.env.PULSE_MINUTE_LANE === 'true'`.

- [ ] **Step 1: Write the failing tests:**

```ts
it('has no minute block with the flag off', ...)
it('adds the minute block with the flag on', ...)
it('pulseNow returns the same reading with the flag on or off', ...)
it('a failed minute read leaves the rest of the score intact', ...)  // minute null
it('keeps the body under 400 KB at 48 hours', ...)                   // 2,880 points
```

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep `points`, `card` and `changes` exactly as they are. Trim minute values to 1 decimal place. Build entries from each cohort's `call_bid` and `put_bid`.
- [ ] **Step 4: Run `npx vitest run src/services/pulse src/lib/algo src/services/algo src/routes`.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 7: Lane and guide, then Stage 2

**Files:**
- Modify: `frontend/index.html` (`paint` for `pulse`, `puValues`, the `#v153Info` guide)
- Create: scratchpad `deploy-stage2.sh`

- [ ] **Step 1: Make `paint('pulse')` use `d.minute` when it is present,** and today's `points` otherwise. Skip the straight-line joining for minute data, so a missing minute stays a gap. Show the fast trigger as a red marker, and `Call hurting` or `Put hurting` in the header from `hurt`.
- [ ] **Step 2: Update the guide:** what damage means, that the futures lines confirm and do not warn, and that the reading is uncalibrated and the algo does not use it.
- [ ] **Step 3: Run the parse check, then view it on localhost** if the PC has memory for it, using sample data.
- [ ] **Step 4: Commit.** Wait until `minute-check.sh` shows 48 hours of rows.
- [ ] **Step 5: Tell the trader, write the deploy script with the flag on, and hand it over.** To roll back, set the flag off and restart.

### Task 8: Leading test (Stage 3)

**Files:**
- Create: `backend/src/lib/pulse/lead-test.ts` and its test
- Create: scratchpad `lead-test.sh`

**Interfaces:**
- Produces: `leadReport(rows: readonly MinuteRow[], entries: ReadonlyMap<string, Entry>): LeadReport`, with hit rate, median lead minutes, false alarm rate and `verdict: 'not enough data' | 'leads' | 'does not lead'`, each for damage and for plain BTC movement.

- [ ] **Step 1: Write the failing tests:**

```ts
it('a jump is premium up 20% of entry within 30 minutes', ...)
it('a high reading is a damage score of 100', ...)
it('says not enough data under 14 days or 20 jumps', ...)
it('says leads only when damage beats plain BTC movement', ...)
it('never counts a jump before its reading', ...)
```

- [ ] **Step 2: Run, implement, and run again.** Expected: FAIL, then PASS.
- [ ] **Step 3: Commit, deploy with the next stage, and give the trader `lead-test.sh`** after 2 weeks.
- [ ] **Step 4: Report the result in plain words,** even if it does not lead.

### Task 9: Connect the algo (Stage 4)

**Do not start this task** unless the test says it leads and the trader approves in that moment.

- [ ] **Step 1: Write the failing test** that the `pulse` condition reads the minute zone, and that a stale minute reading holds the entry.
- [ ] **Step 2: Implement** in `pulseNow`, reusing `PULSE_MAX_AGE_MS`, set to 5 minutes for minute readings.
- [ ] **Step 3: Run the tests, commit, and hand over the deploy.**
