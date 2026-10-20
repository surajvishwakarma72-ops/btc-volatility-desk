# BTC Short-Strangle — Stop-Loss Elimination: Findings

**Data:** 2025-10-06..2026-10-17 (327 nights, Binance 15m/1m + archive IV, BS-repriced)

## Bottom line
Stop-losses are driven overwhelmingly by **entry timing and weekday**, not by entry-time
indicators. The blind strategy wins ~65% but stop-losses erase the edge; the levers that
actually cut SLs, in order of impact:

1. **Trade LATE (22:30–01:00 IST).** SL rate falls from 50–75% (19:00 NY open) to 10–25%
   (23:00+). This single change is the biggest stop-loss reducer.
2. **Skip RSI > 60 nights.** The only entry veto that survives out-of-sample
   (41.8% SL-precision > 34.9% breakeven): SLs 65→42, net roughly doubles.
3. **Pick the weekday.** OOS-validated: **TRADE Mon, Tue, Fri**;
   **SKIP Wed, Thu** (Wed/Thu decayed out-of-sample despite strong
   in-sample numbers), weekends off.

## What does NOT work (myths tested and rejected)
- **Indicator filters** (Speed, VoV, IV-vs-Clock, Edge, ADX, DVOL, Range, IV level): at a
  fixed late entry they barely separate SL from non-SL nights (all effect sizes |d|≤0.24).
- **IV ≥ 35 / IV > RV edge:** net-negative; BTC's Edge is structurally ~−7 (IV below RV).
- **Asymmetric / further-OTM legs:** INCREASE stop-losses (cheaper legs hit 2× faster).
- **Tighter / early stops (1.5–1.75×):** cut too many near-miss winners; 2× is optimal.
- **Delaying vetoed nights** instead of skipping: still net-negative.

## The 2–3 "silence" signals you asked for
The honest answer: the dominant silence signal is **the clock** (late entry). The only
entry-time signal with any edge is **RSI ≤ 60** (avoid overbought-up setups). vol-of-vol
and Speed help *select when to enter* at earlier variable entries (Step 2: 36%→26% SL) but
add nothing at a fixed late entry.

## Conviction
- **HIGH:** Fri (81.8% win, +$3.48/trade, target in ~3.5h).
- **NORMAL:** Mon/Tue (positive but fragile).
- **SKIP:** Wed/Thu (OOS win < 65%), Week-1 of month, RSI>60 nights, weekends.

## Caveats
- Legs BS-repriced from ATM IV (no historical option prices/bid-ask).
- bid-ask>1.5% reject is live-only (not modeled).
- News blackout: no event calendar in data — high-SL months used as a proxy.
- vol-of-vol/skew/GEX/flow are sparse/low-fidelity and did not survive OOS.

See `rulebook.json` for the machine-readable rules and `step*.json` for full tables.
