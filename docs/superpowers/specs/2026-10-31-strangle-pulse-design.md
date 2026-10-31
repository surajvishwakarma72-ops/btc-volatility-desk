# Strangle Pulse: design and plan

## Context
You trade BTC short strangles on Delta India and today only learn an entry was wrong after entering. Strangle Pulse runs paper strangles and paper futures every hour, 24/7, and turns their behaviour into one verdict: SELL NOW, WAIT, AVOID or NO DATA. It is read-only and never touches a real order.

Your pasted brief remains the full spec for formulas, weights, thresholds and phases. This document records only where the repo changes or settles something.

## Goals, non-goals and anti-goals
- **Goal:** know before entry whether to sell, wait or avoid, from live paper cohorts plus a regime gate.
- **Non-goals:** placing orders; changing other panels; reworking the old `shadow-strangle.ts`.
- **Anti-goals (fails even if it runs):**
  - SELL showing on stale or broken data.
  - Indicator covering the page or fighting other lanes.
  - Confidence presented as a proven win rate before calibration exists.

## Decisions you made
1. **UI:** one normal fx-menu entry, "Short Strangle". It is a lane the same height as the other indicators and shares the chart with them. It must never cover the page.
2. **Expiries:** the server runs Current, Next and N2N non-stop. The selector only chooses which one you view. This replaces the spec's "selector change closes all cohorts", because the selector is per-device localStorage (`v89_slot`) that the server cannot see. A real expiry roll still closes that slot's cohorts and starts a fresh series.
3. **Regime gate:** before building it, backtest the spec rules (ADX < 15, IV/RV > 1.3) against the 5-year study rules (RV/IV < 1, low VoV, ADX veto at 40+). You choose from the pass rates and stop rates.

## My calls (correct any you disagree with)
- **Lane contents:** verdict, Confidence %, confidence line, heavy leg, next-cohort countdown, veto count.
- **Other blocks:** open in a small popover anchored to the lane on tap, and close on tap. On phones it stays within the lane's width and never goes full screen.
- **Stop:** flat 2x per spec, in config. Your live gate uses 3x in the 35-45 IV band; that is not applied here unless you say so.
- **Data feed:** poll `/v2/tickers` once a minute instead of streaming the websocket. This provides the 1-minute panel refresh and the 15-minute snapshots at lower load on the 1 GB VM. Bid and ask come from ticker quotes, so no order-book stream is used.
- **Storage:** new `pulse_*` tables in the existing Neon Postgres, not DuckDB. The old `shadow_strangles` table and its code stay untouched and unused.
- **Config:** one file, `backend/src/lib/pulse/config.ts`.
- **Friday:** the verdict is display-only and never forces a skip, so your Friday premium entry stays your decision.

## Known risks
- **Strategy edge:** earlier replays showed unfiltered short strangles losing after costs. The initial weights are your untested judgement until Phase 7, so the UI labels Confidence "uncalibrated" until then.
- **History:** Delta's REST docs show no per-strike OI or Greeks history, so history starts on the day the collector goes live.
- **Volume:** the docs do not say whether ticker `volume` is rolling 24h. If it is, differencing it gives wrong "volume since last snapshot". Phase 1 measures this. If unusable, OI confirmation falls back to candle volume or is flagged unavailable.
- **IV field (resolved):** a live ticker has both `mark_vol` and `quotes.mark_iv` with equal values, plus `oi_contracts` and `volume`, so `parseTicker` is correct.
- **Roll vs calibration:** the brief says both "lifetime expiry to expiry" and "close all on roll". Closing on every daily 17:30 IST roll wins here, so Next and N2N cohorts never reach expiry. Phase 7 must calibrate those on their close at the roll.
- **Storage growth:** about 10k rows a day on average, 21k at the peak (up to 24 live cohorts per slot, 3 rows each, every 15 minutes). The Neon plan limit is unchecked, and the spec keeps all cohorts. Phase 1 logs database size and reports days of runway. If tight, I'll propose thinning old snapshots and will not delete without asking.
- **Regime inputs:** RVP, ADX, DVOL, GEX and events mostly live in the browser. They must be ported to the server or flagged unavailable.
- **Deploy:** the Phase 1 "24 hours straight" test needs the VM. I'll build behind `PULSE_ENABLED`, and I deploy only when you say so.

## Reuse
- `backend/src/services/bot/delta-public.ts`: `fetchChain`, `parseTicker`, `fetchCandles`, `fetchOptionFeeRates` (extend `DeltaTicker` with OI and volume).
- `backend/src/lib/bot/`: `costs.ts`, `strike-picker.ts`, `portfolio-margin.ts`, `sessions.ts`.
- `backend/src/services/bot/gate.ts`, `algo/event-guard.ts`, `iv-rank.ts`: regime inputs.
- `backend/src/services/alert-service.ts`: Telegram.
- `backend/src/services/watch/real-tracker.ts`: live position, read-only.
- `frontend/index.html`: lane pattern at line ~48750 (`LANES`, `lane()`), fx menu at `#gPanesMenu` and the `v132_ind` block.

## Build order
Each phase gets a demo and summary before the next, per section 11 of your brief. All new backend code goes in `backend/src/lib/pulse/` (pure logic, tested) and `backend/src/services/pulse/` (engine, store).

1. **Collector and cohorts:** `pulse_cohorts`, `pulse_leg_snapshots`, `pulse_cohort_snapshots`. HH:30 IST opens for each of the 3 expiries, 15-minute snapshots, roll handling, `NO_VALID_STRIKES`, data-health checks, size logging.
2. **Metrics:** everything in section 5 as pure functions, with hand-calculated unit tests.
3. **Regime gate:** first run the backtest and bring you the comparison. After you choose, build the gate; each input shows a value or "unavailable".
4. **Score and verdict:** weights, vetoes, hysteresis, reasons, sizing, replay script.
5. **Lane, popover, Telegram:** routes in `backend/src/routes/pulse.ts` behind the desk's `authenticate`. Add the lane, popover and throttled alert.
6. **Live position mode:** HOLD, ADJUST or EXIT, read-only.
7. **Calibration and journal.**

## Verification
- `npm test` and `npm run build` in `backend/` every phase (the build runs strict `tsc`, which CI enforces).
- Phase 1: one local cycle against the live public API, then the 24-hour check on the VM once you've deployed.
- Phase 4: replay stored cohorts and read the zone changes.
- Phase 5: run on local :4000/:3000, tick the lane with other lanes on, and confirm in a browser at desktop and phone widths that the page doesn't scroll and the popover stays small. Send one test Telegram message.

## Left to the builder
Table columns, popover styling, and file splits inside `pulse/`.
