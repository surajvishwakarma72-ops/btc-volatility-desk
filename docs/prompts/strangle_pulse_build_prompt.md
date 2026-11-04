# Build Prompt — Strangle Pulse (BTC Short Strangle Decision Engine)

Paste this whole file into Antigravity (or save it in the repo root and tell the agent to follow it).

---

## 0. Your role and ground rules

You are a senior quant developer working inside my existing codebase. Build **Strangle Pulse**: an indicator injected into the **FX indicator panel only**. It runs paper (shadow) BTC short strangles and paper futures positions every hour, 24/7, and turns their behaviour into **one verdict**: should I sell a short strangle now, wait, or avoid?

Rules:

1. **Read-only trading.** Never place, modify or cancel a real order. Every position is simulated from live market data.
2. **Explore before you code.** First find the FX indicator panel, the expiry selector (Current / Next / N2N), the existing data/WebSocket layer, and the stack in use. Reuse existing patterns, components and data clients. Do not introduce a new framework if one already exists.
3. **Plan, then wait.** After exploring, write a short plan (files to add/change, data flow, any open risks) and wait for my approval before writing code.
4. **Touch only what is needed.** No changes to other panels or screens.
5. **Secrets** (Delta API keys, Telegram bot token) come from environment variables only. Never hard-code them.
6. **Verify the Delta Exchange India API** against the official docs before using an endpoint. Do not guess field names. If per-strike OI or Greeks history is not available, history starts the day the collector goes live — say so in your plan.
7. Work in the phases in section 10. Finish and demo each phase before starting the next.

---

## 1. Problem

I trade BTC short strangles on Delta Exchange India. Today I only learn an entry was wrong *after* entering. I need to know *before* entry whether the market is strangle-friendly, whether to wait, or whether to take an early entry.

---

## 2. Core concept: hourly cohorts

- Every hour at **HH:30 IST** (first at 05:30 IST = 00:00 UTC), open one **cohort**:
  - a shadow short strangle (sell 1 call + sell 1 put), and
  - a shadow futures long + a shadow futures short, at the same timestamp.
- 24 cohorts per day, running 24/7.
- Every live cohort is **snapshotted every 15 minutes**.
- The indicator reads all live cohorts, weights the newest most, and outputs a **Confidence %**, a **Zone** and a **Verdict**.

---

## 3. Shadow strangle rules

| Rule | Value |
| --- | --- |
| Entry time | Every HH:30 IST from 05:30, 24/7 |
| Legs | Sell 1 call + sell 1 put, 1 lot each |
| Strike band | abs(delta) 0.10–0.15 per leg; choose the strike closest to 0.125 |
| No strike in band | Log the cohort as `NO_VALID_STRIKES` (this is itself a warning) |
| Expiry | Follow the **master expiry selector** (Current / Next / N2N) |
| Expiry change or roll | When the selector changes or the expiry rolls, close all live cohorts and start a fresh cohort series. The indicator must react immediately. |
| Entry fill | Sell at **bid** (store mid too) |
| Mark / exit price | Buy back at **ask** |
| Virtual stop | Flag `SL_HIT` at 2x entry premium per leg; keep tracking after the flag |
| Lifetime | **Expiry to expiry** |
| Costs | Deduct exchange fees, GST and an estimated slippage from every P&L |

---

## 4. Snapshot data (every 15 minutes, per live cohort)

Store one row per option leg plus one row for the futures pair.

**Per option leg:** timestamp, cohort_id, minutes_since_entry, strike, expiry, bid, ask, mark, mid, delta, gamma, theta, vega, mark IV, OI, change in OI since last snapshot, volume since last snapshot, leg P&L (after costs).

**Per cohort:** BTC spot, BTC futures price, combined premium, combined P&L, P&L as % of premium collected, net delta, futures long P&L, futures short P&L.

**Storage:** use the existing database layer if there is one; otherwise DuckDB. Keep all cohorts — they are needed for calibration.

**Panel refresh:** storage stays on the 15-minute grid, but the panel refreshes live numbers every 1 minute between snapshots.

---

## 5. Metrics (compute per cohort, per 15-minute step)

Every metric is also tracked as a **speed** (change per 15 minutes).

1. **Decay efficiency (per leg)**
   `DE = (P_entry − P_now) / (|theta_entry| × t_elapsed)`
   Above 1.0 = decaying faster than expected; below 0.5 = something is fighting decay.

2. **Leg balance / heavy leg**
   `BalanceDrift = | ln(C_now / P_now) − ln(C_entry / P_entry) |`
   The heavy leg is the one whose premium is rising, or falling clearly slower than the other.

3. **Delta Stability Index (the "speed" check)**
   `DSI = (|Δdelta_call| + |Δdelta_put|) / (|ΔS / S| × 100)`
   - Small BTC move but large delta change → fragile, bad for selling.
   - Large BTC move but delta barely changes → strikes well protected, good.

4. **Net delta drift:** call delta + put delta. Near zero = balanced; steady drift = market leaning on one side.

5. **IV trend:** change in each leg's IV since entry and over the last hour. Falling IV on both legs is good.

6. **Realized vs implied move:**
   `ExpectedMove = S × IV × sqrt(t_elapsed / 365)`
   Ratio = actual BTC range since entry ÷ ExpectedMove. Below 0.7 = quieter than priced (good); above 1.0 = moving more than priced (bad).

7. **OI interpretation (per leg).** Sum OI over the sold strike ± 2 strikes. Count an OI change only if volume in the same window confirms it.

   | Leg premium | Leg OI | Meaning | For the short strangle |
   | --- | --- | --- | --- |
   | Falling | Rising | Writers adding (short build-up) | Strong support |
   | Falling | Falling | Long unwinding | Mild support |
   | Rising | Rising | Fresh buyers (long build-up) | Threat |
   | Rising | Falling | Writers covering (short covering) | Threat |

8. **Spread and liquidity**
   - Spread % per leg = (ask − bid) / mid, compared with its own 24-hour median.
   - Exit cost % = cost to buy both legs back at ask ÷ premium collected.
   - Below 5% normal · 5–10% penalty · above 10% or 2x the 24h median = hard veto.

9. **Futures directional probe**
   - Winner persistence: of the last 6 cohorts, how many have the same futures side winning (5–6 of 6 = trend).
   - Move vs breakeven: largest futures move since entry ÷ distance to nearest strangle breakeven (above 60% = bad).
   - Efficiency ratio: net move ÷ total path travelled (near 0 = sideways, good; near 1 = trending, bad).

10. **Session baseline:** compare each cohort against the typical behaviour of the same hour/session (Asia, London, NY), not the whole day.

11. **Skew and term structure:** 25-delta risk reversal; Current vs Next IV. Inverted term structure (near IV above far IV) = stress veto.

12. **GEX strike quality (if a GEX feed exists in the codebase):** strikes beyond a large gamma wall score higher; strikes inside the gamma-flip zone score lower.

---

## 6. Two-layer decision

SELL NOW requires **both** layers to pass.

| Layer | Question | Inputs |
| --- | --- | --- |
| 1. Regime gate | Is this a selling regime at all? | IV/RV > 1.3, RVP, ADX < 15, killer-pattern veto (RVP rising AND ADX rising), DVOL, event blackout (FOMC, CPI, large Deribit expiries) |
| 2. Live tape | Is the tape quiet right now? | Shadow cohort metrics from section 5 |

If the regime-gate inputs already exist in the codebase, reuse them. If not, build them as a separate module and flag which inputs are missing.

---

## 7. Confidence score

Each component is a sub-score scaled 0–100. Confidence = weighted sum.

| Component | Weight |
| --- | --- |
| Decay quality | 20 |
| Realized vs implied move | 15 |
| Delta stability (DSI + net delta drift) | 15 |
| Leg balance | 15 |
| IV trend | 10 |
| OI support | 10 |
| Futures direction | 10 |
| Spread / liquidity | 5 |

**Recency weighting across cohorts:** last 3 cohorts = 60%, next 3 = 30%, older = 10%.

**Hard vetoes (cap Confidence at 40):**
- spread > 10% or 2x its 24h median on either leg
- latest cohort has `NO_VALID_STRIKES`
- futures winner persistence 5 or 6 of last 6
- killer pattern active
- inverted term structure
- regime gate failed

Put every weight and threshold in **one config file** so I can tune them without touching code.

---

## 8. Zones and verdict

| Zone | Confidence | Verdict |
| --- | --- | --- |
| Sell | 70–100 and regime gate passes | SELL NOW |
| Caution | 45–69 | WAIT |
| Avoid | 0–44 or any hard veto | AVOID |
| — | Stale or missing data | NO DATA |

- **Hysteresis:** a zone changes only after 2 consecutive 15-minute readings on the new side.
- Every zone change is stored with its reason (e.g. "Call OI: short covering").
- **Data-health guard:** stale quotes, API gaps or a missing leg force NO DATA. Never show SELL on broken inputs.

**Verdict card fields:**

| Field | Content |
| --- | --- |
| Verdict | SELL NOW · WAIT · AVOID · NO DATA |
| Strikes | Call and put strike with current delta (0.10–0.15) |
| Premium | Combined credit at bid; breakevens both sides |
| Size | Suggested lots scaled by confidence and available margin |
| Stop | 2x premium per leg, shown as a BTC price level each side |
| Why | Top 3 reasons, plain words |
| What flips it | The one change that would move it to the next zone |

---

## 9. FX panel UI (top to bottom)

1. **Verdict card** (section 8) with Confidence %, zone badge, next-cohort countdown, heavy-leg flag and active vetoes.
2. **Confidence line** over time with three bands: Sell (70–100) on top, Caution (45–69), Avoid (0–44). Dashed marker + reason at each zone change. Provide a toggle to flip to a Risk line (100 − Confidence) with Avoid on top.
3. **Leg balance:** call vs put premium as % of entry; label the heavy leg.
4. **Greek speed:** DSI, net delta drift, IV trend, coloured good / warning / bad.
5. **Cohort heatmap:** rows = cohorts (newest on top), columns = 15-minute snapshots, colour = combined P&L. Staircase shape is expected.
6. **Bottom strip:** OI flow per leg · spread and exit cost · futures probe (persistence, efficiency ratio).
7. **Live position mode:** apply the same metrics to my real open strangle (read-only from the live terminal) and show **HOLD · ADJUST · EXIT**.

Use the existing panel's theme, components and charting library. It must work in dark mode and on a narrow screen.

---

## 10. Build phases and acceptance criteria

**Phase 1 — Collector and cohort engine**
- Always-on service (must run on the server, not a laptop) that streams the option chain, Greeks, OI, order book and futures ticker.
- Opens cohorts at every HH:30 IST, tied to the expiry selector; snapshots every 15 minutes.
- Data-health checks and logging.
- Done when: cohorts open on time for 24 hours straight, snapshots are complete, and an expiry-selector change closes and restarts the series.

**Phase 2 — Metrics**
- All metrics in section 5, with unit tests on hand-made sample data.
- Done when: each metric matches a hand calculation on a test cohort.

**Phase 3 — Regime gate**
- IV/RV, RVP, ADX, killer pattern, DVOL, GEX, event calendar.
- Done when: each input shows a value or is clearly flagged as unavailable.

**Phase 4 — Score, zones and verdict card**
- Weights, vetoes, hysteresis, strikes, size, reasons, config file.
- Done when: a replay of stored cohorts produces zone changes with readable reasons.

**Phase 5 — FX panel and Telegram alerts**
- Panel UI per section 9 via the existing WebSocket/API layer.
- Telegram alert on every zone change (after 2 confirming readings) carrying the verdict card text. Throttle duplicates.
- Done when: the panel updates live and a test zone change sends one Telegram message.

**Phase 6 — Live position mode**
- HOLD · ADJUST · EXIT on my real strangle, read-only.

**Phase 7 — Calibration and journal**
- Calibration table: for each confidence band, the % of cohorts that finished profitable at expiry.
- Decision journal: log each real trade with the verdict at that moment.
- Done when: the calibration table renders from stored cohorts.

---

## 11. Deliverables after each phase

- Short summary of what was built and which files changed.
- How to run and test it.
- Anything that could not be built and why (e.g. a missing API field).
