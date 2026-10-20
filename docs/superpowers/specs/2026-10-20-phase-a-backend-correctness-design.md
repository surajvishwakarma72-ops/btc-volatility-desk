# Phase A — Backend Correctness & Hardening (Design Spec)

**Date:** 2026-10-20
**Status:** Awaiting user review
**Scope:** Backend only (`backend/`). No frontend changes.
**Part of:** BTC Volatility Desk full-stack remediation (Phases A–E). This is Phase A.

---

## 1. Context & Goal

The backend (`Fastify + Drizzle/Postgres`) has a number of data-correctness, security-hardening,
and stats-integrity bugs (catalogued in the remediation issue list). Phase A fixes all backend
issues that do **not** require touching the live frontend monolith (`frontend/index.html`) or the
not-yet-built auth layer.

**Goal:** the backend *computes, stores, and serves correct data* and presents a *hardened,
validated* API surface, with automated tests covering the pure logic.

**Non-goals (explicitly deferred):**
- Authentication / replacing `DEFAULT_USER_ID` → **Phase B**
- Server-side Delta key custody & signing → **Phase C**
- Wiring the live app to read/write Postgres (localStorage → Postgres) → **Phase D**
- Static egress IP, dead-file cleanup, env/secrets ops → **Phase E**

---

## 2. Decisions (confirmed with user)

| Decision | Choice |
|---|---|
| Request validation | `fastify-type-provider-zod` (native integration, typed handlers) — *default; user may switch to no-dep helper* |
| SPEED_BREAK alert | Implement a real **spot-velocity** metric and gate on it |
| Recalibration with thin data | **Keep clearly-labeled seeded baselines**; compute real metrics + real p-value when sample is sufficient |

---

## 3. Work Units

Each unit is independently reviewable and testable.

### Unit 1 — Validation & transport hardening
- Add `fastify-type-provider-zod`; define Zod schemas for body/query/params on **every** route
  (`trades`, `nights`, `drawings`, `preferences`, `alerts`, `market`, `telemetry`, `delta`).
- Global Fastify error handler → consistent envelope `{ success:false, error, details? }`;
  validation failures return `400` with field details.
- Set a request body-size limit (`bodyLimit`, e.g. 1 MB) on the main instance.
- **CORS**: replace `origin:true` with an env-driven allowlist read from `CORS_ORIGINS`
  (comma-separated); keep `credentials:true` for Phase B cookies. Default allowlist =
  localhost dev origins + the configured app origin.
- **DB TLS** (`db/index.ts`): remove `rejectUnauthorized:false`; use `rejectUnauthorized:true`
  with optional `DATABASE_CA` PEM override env for self-managed certs.

### Unit 2 — Alert engine correctness (`services/alert-service.ts`)
- Refactor `sendNotification` to accept `channels: string[]` and **fan out to all channels in a
  single call**. Cooldown is evaluated **once per rule**, keyed by `ruleId`, honoring
  `rule.cooldownSeconds` (fall back to 300s only if unset). Fixes:
  - "only the first channel ever fires" bug
  - ignored `cooldownSeconds`
- `checkMetrics` calls `sendNotification` **once per triggered rule** (not once per channel).
- **Active-rules cache**: load active rules into memory with a short TTL (e.g. 30s) + explicit
  invalidation hook called by `POST/DELETE /alerts/rules`. Stops the per-tick DB query.
- **Delta-tick throttle**: cap alert evaluation to ~1/sec in the Delta worker.
- **IV_SPIKE wiring**: the Deribit worker computes `ivChangePct` from the previous vs current
  DVOL and calls `checkMetrics({ atmIv: currentDvol, ivChangePct })` each poll, so IV_SPIKE rules
  can actually trigger.

### Unit 3 — Market / flow data correctness
- **Deribit dedup** (`services/deribit-flow-worker.ts`): maintain an in-memory `lastTradeSeq`
  high-water mark; only aggregate trades with `trade_seq > lastTradeSeq`. Update the mark after
  each poll. (On process restart the mark resets; at most one 50-trade window may re-aggregate
  once — acceptable, documented.)
- **`option_flow_buckets` PK** (`db/schema.ts`): change primary key from `time` to composite
  `(symbol, time)`; update the upsert `onConflictDoUpdate` target to `(symbol, time)`.
  Generate a Drizzle migration; handle existing rows (single-symbol `BTC` today → safe).
- **`market/candles`** default `interval` `'1d'` → `'1m'` (the only interval currently ingested).

### Unit 4 — Stats integrity
- **Recalibration** (`services/self-testing-audit.ts`):
  - Compute `tueWedStopRate`, `speedStopRate`, `comboStopRate`, `oosStopRate` from real
    `session_audit_logs`.
  - Replace the hardcoded `comboPValue = 0.0012` with a **real one-sided binomial test**
    (observed stops vs a baseline stop-rate, n = sample size).
  - Fix `half = Math.floor(logs.length / 2)` (was `max(logs.length, 269)/2`, which made the OOS
    slice empty until 269 logs).
  - When `logs.length < MIN_SAMPLE` (e.g. 30), fall back to **clearly-labeled seeded baselines**
    (`source: 'seeded_baseline'` in `auditSummary`) rather than silently fabricating numbers; the
    record marks which fields are real vs seeded.
  - Delete the dead/empty archive-load block.
- **Telemetry** (`recordSessionTelemetry`): `outcome` defaults to `null` (pending) for GO sessions
  instead of auto-`WIN`; `WIN`/`STOP` only when explicitly provided. Prevents win-rate inflation
  in `nights/stats` and recalibration.

### Unit 5 — Bootstrap & hygiene
- **Default-user seed**: on server `onReady`, idempotently upsert the `DEFAULT_USER_ID` row so
  current writes don't FK-fail on a fresh DB. (Bridge; Phase B replaces `DEFAULT_USER_ID` with the
  authenticated user and removes this seed.)
- Remove Garman-Klass dead vars (`u`, `d`) in `binance-market-worker.ts`.
- Annotate the empty `migration` route and `types/index.ts` stub as deferred (Phase D) with
  accurate comments (remove misleading "implemented" claims).

### Unit 6 — Tests (new)
- Add **Vitest** (dev dependency) + `npm run test` script.
- Unit tests for pure logic:
  - `calculateGarmanKlassRv` (known inputs → known RV; <5 bars → 0; non-finite guard)
  - `evaluateLockedRule` (calendar/window/speed/GO across representative timestamps)
  - recalibration math + binomial p-value (including INSUFFICIENT→seeded path and `half` slice)
  - alert cooldown + multi-channel fan-out (all channels fire once; second trigger within cooldown
    suppressed)
  - Deribit dedup (overlapping windows do not double-count)
  - Zod schemas (representative accept + reject cases per route)

---

## 4. Spot-velocity metric (Unit 2 detail)

In `binance-market-worker.ts`, on each **finalized** 1-minute bar, compute velocity as the
absolute percentage move over a short rolling window (e.g. last N=3 closes):
`velocity = |close_now - close_{t-N}| / close_{t-N} * 100`. Expose it on the worker and pass it to
`checkMetrics({ spotPrice, speed: velocity })`. `SPEED_BREAK` triggers when `speed >= threshold`.
(The strategy's full "speed vs IV" ratio remains a later signal-engine item; this delivers honest
speed-based alerting now.)

---

## 5. Data / schema migration

- One Drizzle migration for the `option_flow_buckets` composite PK. Existing data is single-symbol
  (`BTC`), so the migration is non-destructive. `drizzle-kit generate` + apply via the existing
  `drizzle.config.ts`.

---

## 6. Acceptance criteria

- `npm run build` (tsc) passes; `npm run test` (vitest) passes.
- All routes reject malformed input with `400` + details; valid input unchanged.
- Alerts: a single trigger delivers to **every** configured channel exactly once; repeat within
  `cooldownSeconds` is suppressed; IV_SPIKE fires on a simulated DVOL jump.
- Deribit flow: replaying overlapping poll windows does not inflate bucket volumes.
- Recalibration: real metrics when sample ≥ MIN; labeled seeded baselines below MIN; `clearedBonferroni`
  derived from a real p-value; OOS slice non-empty for any `logs.length ≥ 2`.
- Telemetry never auto-labels an outcome as `WIN`.
- Fresh DB: server boot seeds the default user; writes succeed without FK errors.
- CORS rejects non-allowlisted origins; DB connects with cert validation on.

---

## 7. Risks & mitigations

- **Schema migration on a live DB** → non-destructive (single symbol), tested on a scratch DB first.
- **Validation tightening may reject payloads the current app sends** → schemas modeled on existing
  handler expectations; `delta` proxy schema kept permissive for Phase C.
- **In-memory dedup/rules cache reset on restart** → documented, bounded, acceptable for Phase A.

---

## 8. Rollout

Single feature branch `phase-a-backend-correctness`, committed per work unit for reviewability.
Merges to `main` after user review + green tests. Phases B–E follow as separate spec → plan cycles.
