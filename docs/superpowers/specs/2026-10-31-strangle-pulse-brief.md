# Strangle Pulse: user's brief, sections 5-10

The user's own requirements, kept here because later phases work from them. Sections 1-4 are built (Phase 1). The design document records where the repo changed or settled something, and it wins over this file on conflict.

## 5. Metrics (per cohort, per 15-minute step)
Every metric is also tracked as a speed (change per 15 minutes).

- **Decay efficiency (per leg):** `DE = (P_entry - P_now) / (|theta_entry| x t_elapsed)`. Above 1.0 = decaying faster than expected; below 0.5 = something is fighting decay.
- **Leg balance / heavy leg:** `BalanceDrift = | ln(C_now / P_now) - ln(C_entry / P_entry) |`. The heavy leg is the one whose premium is rising, or falling clearly slower than the other.
- **Delta Stability Index:** `DSI = (|Δdelta_call| + |Δdelta_put|) / (|ΔS / S| x 100)`. Small BTC move but large delta change = fragile, bad for selling. Large BTC move but delta barely changes = strikes well protected, good.
- **Net delta drift:** call delta + put delta. Near zero = balanced; steady drift = market leaning on one side.
- **IV trend:** change in each leg's IV since entry and over the last hour. Falling IV on both legs is good.
- **Realized vs implied move:** `ExpectedMove = S x IV x sqrt(t_elapsed / 365)`. Ratio = actual BTC range since entry / ExpectedMove. Below 0.7 = quieter than priced (good); above 1.0 = moving more than priced (bad).
- **OI interpretation (per leg):** sum OI over the sold strike +/- 2 strikes. Count an OI change only if volume in the same window confirms it.

| Leg premium | Leg OI | Meaning | For the short strangle |
|---|---|---|---|
| Falling | Rising | Writers adding (short build-up) | Strong support |
| Falling | Falling | Long unwinding | Mild support |
| Rising | Rising | Fresh buyers (long build-up) | Threat |
| Rising | Falling | Writers covering (short covering) | Threat |

- **Spread and liquidity:** spread % per leg = (ask - bid) / mid, compared with its own 24-hour median. Exit cost % = cost to buy both legs back at ask / premium collected. Below 5% normal; 5-10% penalty; above 10% or 2x the 24h median = hard veto.
- **Futures directional probe:** winner persistence: of the last 6 cohorts, how many have the same futures side winning (5-6 of 6 = trend). Move vs breakeven: largest futures move since entry / distance to nearest strangle breakeven (above 60% = bad). Efficiency ratio: net move / total path travelled (near 0 = sideways, good; near 1 = trending, bad).
- **Session baseline:** compare each cohort against the typical behaviour of the same hour/session (Asia, London, NY), not the whole day.
- **Skew and term structure:** 25-delta risk reversal; Current vs Next IV. Inverted term structure (near IV above far IV) = stress veto.
- **GEX strike quality (if a GEX feed exists):** strikes beyond a large gamma wall score higher; strikes inside the gamma-flip zone score lower.

## 6. Two-layer decision
SELL NOW requires both layers to pass.
1. **Regime gate (is this a selling regime at all?):** IV/RV > 1.3, RVP, ADX < 15, killer-pattern veto (RVP rising AND ADX rising), DVOL, event blackout (FOMC, CPI, large Deribit expiries).
2. **Live tape (is the tape quiet right now?):** shadow cohort metrics from section 5.

Reuse existing regime inputs; otherwise build a separate module and flag what is missing.

## 7. Confidence score
Each component is a sub-score 0-100. Confidence = weighted sum.

| Component | Weight |
|---|---|
| Decay quality | 20 |
| Realized vs implied move | 15 |
| Delta stability (DSI + net delta drift) | 15 |
| Leg balance | 15 |
| IV trend | 10 |
| OI support | 10 |
| Futures direction | 10 |
| Spread / liquidity | 5 |

Recency weighting across cohorts: last 3 cohorts = 60%, next 3 = 30%, older = 10%.

Hard vetoes (cap Confidence at 40): spread > 10% or 2x its 24h median on either leg; latest cohort has `NO_VALID_STRIKES`; futures winner persistence 5 or 6 of last 6; killer pattern active; inverted term structure; regime gate failed.

All weights and thresholds in one config file.

## 8. Zones and verdict
| Zone | Confidence | Verdict |
|---|---|---|
| Sell | 70-100 and regime gate passes | SELL NOW |
| Caution | 45-69 | WAIT |
| Avoid | 0-44 or any hard veto | AVOID |
| - | Stale or missing data | NO DATA |

Hysteresis: a zone changes only after 2 consecutive 15-minute readings on the new side. Every zone change is stored with its reason (e.g. "Call OI: short covering"). Stale quotes, API gaps or a missing leg force NO DATA. Never show SELL on broken inputs.

Verdict card: Verdict; Strikes (call and put with current delta, 0.10-0.15); Premium (combined credit at bid, breakevens both sides); Size (suggested lots scaled by confidence and available margin); Stop (2x premium per leg, as a BTC price level each side); Why (top 3 reasons, plain words); What flips it (the one change that would move it to the next zone).

## 9. FX panel UI (top to bottom)
1. Verdict card with Confidence %, zone badge, next-cohort countdown, heavy-leg flag, active vetoes.
2. Confidence line over time with three bands: Sell (70-100), Caution (45-69), Avoid (0-44). Dashed marker + reason at each zone change. Toggle to a Risk line (100 - Confidence).
3. Leg balance: call vs put premium as % of entry; label the heavy leg.
4. Greek speed: DSI, net delta drift, IV trend, coloured good / warning / bad.
5. Cohort heatmap: rows = cohorts (newest on top), columns = 15-minute snapshots, colour = combined P&L.
6. Bottom strip: OI flow per leg; spread and exit cost; futures probe (persistence, efficiency ratio).
7. Live position mode: same metrics on the real open strangle (read-only), showing HOLD, ADJUST or EXIT.

Dark mode and narrow screens must work.

## 10. Remaining phases
- **Phase 2, Metrics:** all of section 5 with unit tests on hand-made data. Done when each metric matches a hand calculation on a test cohort.
- **Phase 3, Regime gate:** IV/RV, RVP, ADX, killer pattern, DVOL, GEX, event calendar. Done when each input shows a value or is flagged unavailable.
- **Phase 4, Score, zones and verdict card:** weights, vetoes, hysteresis, strikes, size, reasons, config file. Done when a replay of stored cohorts produces zone changes with readable reasons.
- **Phase 5, FX panel and Telegram:** panel per section 9; Telegram on every zone change after 2 confirming readings, with the card text; throttle duplicates. Done when the panel updates live and a test zone change sends one message.
- **Phase 6, Live position mode:** HOLD, ADJUST, EXIT on the real strangle, read-only.
- **Phase 7, Calibration and journal:** per confidence band, % of cohorts profitable at expiry; log each real trade with the verdict at that moment. Done when the table renders from stored cohorts.

After each phase: what was built and which files changed, how to run and test it, and anything that could not be built and why.
