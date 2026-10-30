# BTC Volatility Desk: Agent Execution Plan

**Read this file first, then `BTC_Volatility_Desk_Master_Plan_v2.md` (the spec).**
This file says HOW to carry out the spec: the rules, the order, the exact checks. Where the two files disagree, **this file wins** (see Section 4).

The owner (Abhishek) is not a programmer. He pastes your output back to Claude and approves each phase. Write every report in plain English.

---

## 1. Rules of Engagement (non-negotiable)

1. **One task at a time.** Do the task ID you are given, nothing else. Do not "also fix" things you notice. List them under "Noticed, not changed" in your report.
2. **Audit before you edit.** Never assume a file path. The spec mentions `backend/src/lib/bot/strike-picker.ts` and `frontend/index.html`; confirm each path exists with a search before using it. If a path is different, use the real one and say so.
3. **Two kinds of task.**
   - **BACKEND** (no visible change): you may build after the owner approves the wave.
   - **UI** (anything the owner will see): first produce a **mockup** (a static HTML page or an image) and **stop**. Build only after the owner replies "approved".
4. **No layout damage.** New visible elements must not add extra rows, extra height, or shift existing alignment. Prefer recolouring or reusing an existing element. Every UI change must look correct in **both light and dark theme**, on **desktop and a phone-width screen (390 px)**.
5. **Genuine numbers only.** Show only measured values. Anything based on an assumption (for example starting weights) must carry the label **"Unvalidated"** until a backtest supports it. Do not invent data to fill gaps. Show a gap instead.
6. **Do not change backtested rules or thresholds** unless the task says so.
7. **Never deploy.** Work on a branch named `feature/<task-id>`. Do not push to the live branch, do not trigger a production deploy. The owner approves deployment separately.
8. **Never touch real money paths without tests.** Anything that can place, cancel or size an order needs a passing automated test before you report done.
9. **Secrets.** API keys and secrets are never logged, never sent to the browser, never written into audit rows or reports.
10. **Do not delete or rewrite working code** to "clean up". Add or edit the minimum needed.
11. **Run checks after every task** (Section 7) and paste the real output, not a summary of it.
12. **If a requirement is unclear, or a Stop-and-Ask condition (Section 9) is hit, stop and ask.** Do not guess.

---

## 2. Resolved Decisions (use these, do not re-ask)

| ID | Decision |
|---|---|
| D1 | **Dual-account mode is the default**: one read-only key stream and one read+trade key stream, controlled by a config flag `ACCOUNT_MODE = "dual" | "single"`. In `single` mode there is one stream and the Arm switch only gates order dispatch. |
| D2 | Session grid (IST, configurable in one `SESSIONS` object): Asia 05:30 to 12:30 (halves 05:30 to 09:00, 09:00 to 12:30), London 12:30 to 19:30 (halves 12:30 to 16:00, 16:00 to 19:30), New York 19:30 to 05:30 next day (halves 19:30 to 00:30, 00:30 to 05:30). |
| D3 | Voice recognition uses the browser `hi-IN` recogniser (fallback `en-IN`). It is not fully offline, and the UI says so in one line. |
| D4 | Tick-by-tick read-only P&L: 30 days raw, then 1-minute rollups kept. |
| D5 | The owner kill switch on other users' positions is **built but switched off** behind a feature flag `ENABLE_ADMIN_KILL_SWITCH = false` until the owner decides how other users' trade keys are stored. Build everything else in the tracker. |
| D6 | All time displays and day boundaries use **IST**. |
| D7 | Item 29 (login lock) is a current requirement. Any earlier "no password lock" setting in the new app is replaced by it. |

---

## 3. Facts You Must Respect (Delta Exchange India)

- `mark_vol` is returned as a decimal (0.165 means 16.5 percent). If the value is below 5, multiply by 100.
- ATM IV = average of call and put `mark_vol` at the strike closest to live spot.
- `/v2/tickers` **requires** `expiry_date`; without it the call returns HTTP 400. Use the two-step flow: `/v2/products`, then `/v2/tickers?expiry_date=...`.
- Daily options roll at about 17:30 IST. IV series that cross this time must use constant-maturity IV (Section 6, T4.2), not raw "nearest expiry" IV.
- Signed requests need a correct timestamp. A rejected signature often means clock skew, not a bad key.
- Delta India API has rate limits. Count requests per minute for every polling loop you add, and report the total.
- The existing project has a known parse warning at script block #31 in the old single-file HTML. It is not a new error.

---

## 4. Overrides to the Master Plan v2

These changes fix points where v2 would produce wrong or unverified behaviour. Follow this table.

| # | v2 says | Do this instead |
|---|---|---|
| O1 | Section 10: suitability score feeds the Go Gauge | The score runs in **shadow mode**: it is shown only as a small "Unvalidated" read, and does **not** feed the Go Gauge or any order decision until the owner approves a backtest. The factor weights are starting guesses. |
| O2 | Section 8.7: confidence score shown as a meter | Show the meter only with its sample size next to it. Under 200 completed cohorts it reads "Low data" and is greyed. |
| O3 | Section 9.2: exclude event days | Also **exclude Saturdays and Sundays (IST date)** from average and percentile statistics. Make this a setting `EXCLUDE_WEEKENDS = true` by default. |
| O4 | Section 4: kill switch is active | Per D5 it exists behind a flag that is off. |
| O5 | Section 6.1: signs of the Greek terms were written with minus signs | Use the exact formulas in Section 5 below, which use a signed quantity (negative for short). |
| O6 | Section 8.2: synthetic strike described loosely | Use the exact formulas in Section 5 below. |

---

## 5. Exact Formulas

### 5.1 Greek P&L attribution (per leg, between two consecutive ticks)

Definitions: `q` = signed quantity in contracts (negative for a short leg), `cv` = contract value (underlying units per contract), Greeks are **per one option unit** at the start of the interval: `Δ` delta, `Γ` gamma, `Θ` theta per day, `ν` vega per 1 volatility point, `ΔS` spot change in USD, `Δt` elapsed time in days, `ΔIV` change in IV in volatility points.

```
delta_pnl = q * cv * Δ * ΔS
gamma_pnl = q * cv * 0.5 * Γ * ΔS^2
theta_pnl = q * cv * Θ * Δt
vega_pnl  = q * cv * ν * ΔIV
other_pnl = total_pnl_change - (delta_pnl + gamma_pnl + theta_pnl + vega_pnl)
```

Requirements:
- `total_pnl_change` is computed from marks, independently of the Greeks.
- `other_pnl` is the residual, so the five parts always sum exactly to the total.
- Position totals are the sum over legs. The floating widget shows the sum since entry and the last-interval value.
- Test: for a synthetic two-leg strangle with known inputs, the five parts sum to the total within 1e-9.

### 5.2 Synthetic strikes at 0.125 delta (no listed strike inside 0.10 to 0.15)

Assumptions: risk-free rate treated as 0. `S` spot, `σ` IV (decimal), `T` time to expiry in years, `z = 1.1503` (the 87.5 percent normal quantile).

```
call strike  Kc = S * exp(  z * σ * sqrt(T) + 0.5 * σ^2 * T )   # call delta  = +0.125
put strike   Kp = S * exp( -z * σ * sqrt(T) + 0.5 * σ^2 * T )   # put delta magnitude = 0.125
```

- Because IV differs by strike (skew), compute `σ` for each leg from the interpolated surface at the candidate strike and repeat the calculation up to 3 times until the strike changes by less than 0.1 percent.
- Round to the listed strike step only for display. Keep the raw value for pricing.
- Label the cohort `is_synthetic = true`. Never use synthetic strikes for real orders.
- Test: price both strikes with Black-Scholes and check that the computed delta is within 0.0005 of 0.125.

### 5.3 Net P&L (bot runs)

```
gross_pnl = sum over legs of (entry_avg_fill - exit_avg_fill) * qty * cv      # for short legs
fees      = sum of (fee + fee_tax) over all fills of the run
net_pnl   = gross_pnl - fees
```
Only exchange fills linked by `bot_run_id` are used. Marks are never used for closed runs.

### 5.4 Usual IV Fall

For each session half and each past eligible day: `fall_pct = (IV_end - IV_start) / IV_start * 100`, where IV is **constant-maturity ATM IV (1-day)**. Eligible day = not an event day and, when `EXCLUDE_WEEKENDS` is true, not Saturday or Sunday (IST). Report the median and the 25th to 75th percentile band over the last N = 30 eligible days, plus the sample size. If the sample size is below 10 show "Low data".

---

## 6. Task List

Each task has an ID, a type, the spec section, and **acceptance criteria**. A task is done only when every criterion is met and the checks in Section 7 pass.

### Wave 0: Read-only audit (no code changes)

**T0.1 (BACKEND, read-only).** Produce `AUDIT.md` containing:
1. Repo map: top-level folders, language and framework per folder, how to build, test and run.
2. Baseline: the build and test commands run on the untouched code, with their real output.
3. For each item 5 to 29 of the requirements: the real file paths and function names where it lives today, or "does not exist".
4. Current database tables and columns, compared with every `CREATE TABLE` and `ALTER TABLE` in the master plan. List exact differences.
5. Location of: the strike picker, `askTrade`, the floating P&L widget, the P&L analysis page, every time lock (search for `1:30`, `01:30`, `7:00`, `07:00`, `21:00`), every polling loop with its interval, every separate theme toggle, the Ask Me order flow.
6. For item 23: the list of the seven checks in v2 Section 6.4 with "confirmed bug", "not a bug" or "cannot tell", each with evidence (file, line, or sample data).
7. For item 7: the exact code that computes bot net P&L today and which of the likely causes in v2 Section 6.3 it matches.

**Gate:** owner reads `AUDIT.md` and approves Wave 1.

### Wave 1: Security, tracker, voice (items 28, 29)

| ID | Type | Spec | Acceptance criteria |
|---|---|---|---|
| T1.1 | UI (mockup first) | §3 | Lock screen mockup in light and dark. After approval: full-screen gate mounts before any panel; **zero** market, chart or position network calls happen before `GET /auth/me` succeeds (proved with a network log); wrong password shows a clear error; 5 failed attempts in 10 minutes triggers a cooldown. |
| T1.2 | BACKEND | §3 | Passwords stored hashed (argon2 or bcrypt); JWT or session expiry works; 30-minute inactivity lock works; `Lock Terminal` button works; automated tests for login, expiry, lockout. |
| T1.3 | BACKEND | §4 | `desk_password_resets`, `desk_feedback`, `desk_admin_audit` and the `users` columns created by a migration that is safe to run twice. |
| T1.4 | BACKEND then UI | §4 | A reset request stays `pending_owner_approval`; only an admin can approve or reject; approved link is single-use and expires in 30 minutes; every decision writes an audit row. Test: a non-admin calling the approve endpoint gets HTTP 403. |
| T1.5 | UI (mockup first) | §4 | Owner tracker page: online dot (seen in last 60 s), mode pill, key badges, open positions read-only, force READ ONLY works and is audited, Audit tab lists rows. Kill switch button is present but disabled with the text "Disabled by owner setting" (D5). |
| T1.6 | UI (mockup first) | §4 | Feedback modal for users with category, title and multiline text; owner list with Archive (confirm step). Archive sets `status = archived`; hard delete is a second, separate confirm. |
| T1.7 | UI (mockup first) | §13 | Voice assistant: states idle, listening, thinking, speaking; Devanagari transcript; answers only from live desk state; it **cannot place or close orders**; "exit position" only opens the on-screen confirm and needs Arm. One-line notice that recognition is not offline. Test the four scenarios in v2 Section 2 (trade how-to, market state, live P&L, exit while disarmed and armed). |

**Gate:** owner approves Wave 2.

### Wave 2: Streams, Arm switch, P&L foundation (items 5, 6, 7, 10, 15, 23)

| ID | Type | Spec | Acceptance criteria |
|---|---|---|---|
| T2.1 | BACKEND | §6.5 | `fills` table and `bot_runs` columns migrated safely; fills poller upserts on `(account_kind, exchange_fill_id)`; polling the same fills twice creates no duplicates (test). |
| T2.2 | BACKEND | §6.3, §5.3 | `net_pnl` per Section 5.3; tests: one full fill, partial fills, stop-loss exit, expiry settlement, fees on both sides; reconciliation job compares a day's total with the wallet balance change and sets `reconciled`. |
| T2.3 | BACKEND | §6.2 | Backend recorder writes `pnl_ticks` for the read account even when no browser is open (proved by stopping the browser and checking row growth); batch inserts; 30-day raw retention job plus 1-minute rollup job. |
| T2.4 | BACKEND | §6.1, §5.1 | Attribution service with the exact formulas; the sum test passes. |
| T2.5 | UI (mockup first) | §5 | Floating P&L shows the five parts and the "updated Ns ago" age; warning appears only when age exceeds 6 s; reason code on hover for each failure case in v2 Section 5; fallback `calc` delta works when ticker greeks are missing (test with a missing ticker). Reuse the existing warning element. |
| T2.6 | BACKEND then UI | §5 | Polling uses chained `setTimeout`, not `setInterval`; resumes on tab focus. Arm state is enforced **on the server**: a trade-kind order while disarmed returns an error even if the UI is bypassed (test). Header Arm toggle per the approved mockup; read streams keep running in both states. |
| T2.7 | BACKEND, report first | §6.4 | Using the T0.1 audit, write `PNL_AUDIT.md` with each of the seven causes confirmed or not, using real data. Fix **only confirmed** causes. After the fix, every number on the P&L Analysis page shows its source (fills or marks), account and period, plus a Reconciled or Unverified badge. |
| T2.8 | BACKEND | §8.8, §9.2 | Start the `iv_snapshots` collector (every minute, constant-maturity 1-day and 7-day ATM IV, spot, RV 1h and 4h) and the `shadow_cohorts` creator (every hour on the hour, IST). No UI yet. |

**Gate:** owner approves Wave 3.

### Wave 3: Strict picker and order feedback (items 18, 19, 20, 26, 27)

| ID | Type | Spec | Acceptance criteria |
|---|---|---|---|
| T3.1 | BACKEND | §7 | One shared `pickStrangleStrikes()` used by Ask Me, the bot **and** paper trading. `belowTolerance` and `aboveTolerance` removed. When a leg has no strike with delta in [0.10, 0.15], the order is denied, **no row is written anywhere** (including `bot_runs` and paper history), and the backend returns HTTP 422 even if called directly. Tests for deltas 0.0999, 0.10, 0.15, 0.1501 and a missing quote. |
| T3.2 | UI (mockup first) | §13 | Collateral alarm: chime and top banner when available collateral is below required margin, live account only; also checked just before order dispatch. |
| T3.3 | UI (mockup first) | §13 | Ask Me button locks instantly, shows "Please wait, placing order" with a running timer, then a tick on success or an error state. Report the measured time of each step of the order flow and parallelise independent calls. |
| T3.4 | UI (mockup first) | §13 | Full-screen alert on every real algo entry and every real exit; dismiss button; sound with a mute setting; paper trades do not trigger it. |

**Gate:** owner approves Wave 4.

### Wave 4: Intelligence layer (items 11, 12, 13, 14, 16, 17, 21, 22, 24, 25)

| ID | Type | Spec | Acceptance criteria |
|---|---|---|---|
| T4.1 | BACKEND | §9.3 | One `SESSIONS` config object (D2) used by every module. Every time lock found by T0.1 is removed. Test: strike picker and all modules return data at 03:00, 10:00, 15:00 and 22:00 IST. |
| T4.2 | BACKEND then UI | §9.2, §5.4 | Usual IV Fall uses Section 5.4. UI shows median, band, sample size, and a backtest hit rate beside the number. Under 10 eligible days it shows "Low data". |
| T4.3 | BACKEND then UI | §8 | Shadow engine and FX tab: cohorts, 15-minute candle metrics, fallback ladder of §8.2 with Section 5.2 formulas, gap markers when no data, call and put decay lines, top "do not trade" band, bottom "trade" band, risk split, confidence meter (O2), live position overlay (§8.6). |
| T4.4 | UI (mockup first) | §8.9 | "IV waiting for" panel ranking the eight checks; each reason shows the number behind it; if none apply it says so. A nightly job stores hours where IV did not fall when expected, with what happened next. |
| T4.5 | UI (mockup first) | §10, O1 | Suitability score in shadow mode, labelled "Unvalidated", each factor's contribution visible, not wired to the Go Gauge. |
| T4.6 | UI (mockup first) | §11 | Go Gauge adds live leg delta, which leg is heavy, position gamma and IV; during a sharp spot move it shows "unreliable, legs unbalanced" instead of a green signal. |
| T4.7 | BACKEND then UI | §12 | BTC, ETH, AXUSD switcher. **First check** that AXUSD options exist on Delta India and report the real symbols; if not, stop and ask (Section 9). |
| T4.8 | UI | §13 | One theme root and one toggle; every isolated per-panel theme switch removed; checked in light and dark on every page. |
| T4.9 | UI (mockup first) | §9.3 | News from all sources tagged by session and impact, all high-impact news plotted on the chart; ATM IV indicator for Asia, London and NY; IV vs Clock for 24 h with no fixed 21:00; Flow panel per session; Best indicator for 24 h. |

---

## 7. Checks After Every Task

Run and paste the real output of each:

```
npm --prefix backend run build
npm --prefix backend test
npm --prefix frontend run build
```

Plus:
1. A search proving no new hard-coded time locks were added (`01:30`, `1:30`, `07:00`, `7:00`, `21:00`).
2. A search proving no secret, key or token appears in any log statement you added.
3. For UI tasks: screenshots at 1440 px and 390 px, light and dark.
4. For anything with polling: the new requests per minute.
5. If any previously passing test now fails, stop and report. Do not edit the test to make it pass.

---

## 8. Report Template (every task ends with this)

```
TASK: <id and name>
STATUS: done | blocked | needs approval
WHAT CHANGED (plain English, 3 to 6 lines):
FILES CHANGED: <list>
CHECKS: <real output pasted>
HOW THE OWNER CAN SEE IT WORK (2 to 4 simple steps):
NOTICED, NOT CHANGED: <list or "none">
QUESTIONS: <list or "none">
```

---

## 9. Stop and Ask

Stop and ask the owner when:
- a file or function named in the spec does not exist and no clear match is found;
- a change would touch an order-placing path without a way to test it;
- the Delta API returns something that contradicts Section 3;
- AXUSD options are not available (T4.7);
- the audit finds that a fix requires changing a backtested rule;
- a migration would change or delete existing data;
- the change would add rows, height or misalignment to an existing screen;
- anything would be deployed, pushed to the live branch, or run against the real trading account.

---

## 10. Prompts to Paste

### Prompt A (start of every session)
```
Read BTC_Desk_Agent_Execution_Plan.md fully, then BTC_Volatility_Desk_Master_Plan_v2.md.
Follow the Execution Plan's rules exactly. Where the two files disagree, the Execution Plan wins.
Do not write or change any code until I give you a task ID.
Reply only with: "Read both files. Ready for a task ID." and a list of any contradictions you found.
```

### Prompt B (audit)
```
Task T0.1. Read-only. Do not change any file except creating AUDIT.md.
Follow Section 6, Wave 0 of the Execution Plan. Use the report template in Section 8.
```

### Prompt C (any later task)
```
Task <ID> from the Execution Plan.
Work on branch feature/<ID>. Do only this task.
If the task type is UI, produce the mockup only and stop for my approval.
When done, run the checks in Section 7 and reply using the Section 8 report template.
Do not deploy anything.
```

---

## 11. Final Acceptance (end of Wave 4)

1. A first-time visitor in a private window sees only the lock screen and the network log shows no data calls.
2. A password reset cannot complete without owner approval.
3. With the Arm switch off, an order sent straight to the backend is rejected, and read streams keep updating.
4. A strangle with no strike in 0.10 to 0.15 delta is refused in live, bot and paper, and no row is written.
5. A closed bot run's net P&L equals the exchange fills minus fees, and the day total reconciles with the wallet change.
6. The five Greek parts sum to the total P&L on the floating widget.
7. Read-only P&L ticks keep recording with the browser closed.
8. All modules show data at 03:00, 10:00, 15:00 and 22:00 IST.
9. Every statistic shows its sample size; anything unvalidated is labelled "Unvalidated".
10. Light and dark themes both look correct on every page, desktop and phone.
11. No secret appears in logs, browser storage, audit rows or reports.
