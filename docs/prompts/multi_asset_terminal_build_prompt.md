# Build Prompt v2 — Reliable Multi-Asset Terminal (BTC · ETH · XAUT gold)

Paste this into Antigravity, or save it in the repo root and tell the agent to follow it. Replaces v1.

---

## 0. Goal and principles

Make the whole terminal work for **BTC, ETH and XAUT (tokenized gold) options** on Delta Exchange India, switched by **one asset selector**. Every panel must change with it.

The standard for this work is **reliability**: a number on screen is either verified, or it is visibly marked as degraded or unavailable. The terminal must never show a confident number built on bad, stale or missing data.

Five principles:

1. **Discover, never hard-code.** Symbols, expiries, strikes, contract value, tick size, settlement times all come from the Delta Exchange India products API. Verify every endpoint and field in the official docs.
2. **One pipeline, many assets.** One collector, one schema, one metrics engine, parameterised by asset. No copy-pasted BTC code for ETH.
3. **Server is the source of truth.** All collection, metrics and P&L run on the server, 24/7, for all assets, whatever is on screen. The browser only displays.
4. **Quality before display.** Every value passes data-quality checks before a panel uses it (section 4).
5. **Readiness is computed, not assumed.** Each panel, for each asset, shows whether it is FULL, LIMITED or OFF, with the reason (section 5).

Ground rules for you (the agent):
- Explore first; list every BTC assumption in the code (file and line) in a diagnosis report; wait for approval.
- Never place, modify or cancel an order while testing.
- Strike selection is 0.10–0.15 absolute delta for every asset.
- Algo and Strangle Pulse cohorts are **off by default** for ETH and XAUT until I enable them.

---

## 1. Architecture

```
Delta products API ──► Asset Registry (refreshed every 15 min + on expiry roll)
Delta WebSocket/REST ─► Collector (per asset, server-side, 24/7)
                         └─► Raw store (ticks, chain snapshots, fills)
                               └─► Quality Gate (section 4)
                                     └─► Clean store (asset column on every row)
                                           └─► Metrics engine (IV, RV, Greeks, OI, sessions, Strangle Pulse…)
                                                 └─► Readiness engine (section 5)
                                                       └─► API / WebSocket ─► Terminal panels
```

- Raw data is never overwritten; clean data and metrics can always be recomputed from it.
- Every row carries `asset`, `source`, `exchange_ts`, `received_ts`, `quality_flag`.

---

## 2. Asset Registry

Built from the products API; one entry per asset:

| Field | Use |
| --- | --- |
| asset, display name | BTC / ETH / Gold (XAUT) |
| index / spot symbol | Chart, RV |
| futures / perpetual symbol | Futures probe, hedge |
| expiries → Current / Next / N2N | Expiry selector; missing tiers greyed out |
| strikes per expiry | Strike Picker, chain |
| contract value, tick size, min lot, fees | Sizing, P&L |
| settlement time | Sessions, cohort roll |
| market calendar | Crypto 24/7; gold follows gold market hours |
| external feeds | DVOL for BTC/ETH (Deribit); none for XAUT |
| thresholds | Per-asset IV/RV gate, ADX, spread veto, zone bands — marked `uncalibrated` until fitted |

Registry changes (new expiry, delisted strike) are logged and pushed to the screen.

---

## 3. Asset switcher (UI)

- One selector in the header: **BTC · ETH · Gold**.
- On switch: clear every panel, unsubscribe old streams, subscribe new ones, show skeleton loaders, and render only once fresh data for the new asset has arrived. No panel may ever show the previous asset's numbers.
- Asset name and an asset accent colour appear in every panel title.
- Positions, P&L, alerts and the algo log always show **all assets** with an asset column, because positions can be open in several assets.
- Order ticket, Ask-me and voice read-back state the asset by name before any confirmation.

---

## 4. Quality Gate (checks before display)

Each check sets a `quality_flag` on the value: OK, WARN or FAIL.

| Check | Rule (thresholds per asset in config) |
| --- | --- |
| Staleness | Quote or Greek older than X seconds → WARN; older than Y → FAIL |
| Crossed / empty book | bid ≥ ask, or bid/ask missing → FAIL |
| Spread | Spread % above asset limit → WARN |
| IV sanity | IV recomputed from mark price with Black-Scholes must match exchange IV within tolerance → else WARN |
| Delta sanity | Call delta in 0–1, put delta in −1–0, monotonic across strikes → else FAIL |
| Put-call parity | Same-strike call − put ≈ forward − strike (discounted) within tolerance → else WARN |
| Price jump | Underlying move larger than N× recent volatility in one tick → hold and confirm with next tick |
| OI sanity | Negative or impossible jumps → FAIL |
| Gap detection | Missing ticks or snapshots longer than X → mark gap; never interpolate silently |
| P&L reconciliation | Terminal P&L vs exchange positions/fills/wallet within tolerance → else WARN on P&L panel |

Panels use only OK values; WARN values are shown with an amber marker; FAIL values are not shown.

---

## 5. Readiness engine (per asset, per panel)

Each panel shows a badge:

| Badge | Meaning |
| --- | --- |
| **FULL** | Data passes quality checks, enough history, thresholds calibrated |
| **LIMITED** | Works, but with a stated limit — e.g. "thin chain", "history: 12 of 60 days", "thresholds uncalibrated", "no DVOL" |
| **OFF** | Cannot be shown reliably — reason stated, no numbers shown |

Readiness is recomputed live. Examples:
- XAUT Strangle Pulse → LIMITED or OFF when no strike sits in 0.10–0.15 delta or spreads breach the veto.
- ETH session IV fall → LIMITED ("collecting history") until enough sessions are stored.
- Any panel → OFF if its asset's feed is down, with last good time.

Verdicts (SELL NOW, HOLD/EXIT) are only allowed when the panel is FULL. When LIMITED, show the analysis but replace the verdict with **"Observe only"**.

---

## 6. Asset-specific notes

**ETH** — same structure as BTC; lower liquidity, so the spread and staleness checks will trigger more often. DVOL is available.

**XAUT (gold)**
- Real gold markets close at weekends; tokenized gold can look flat then. Weekend RV and session statistics must use gold's calendar.
- Thin option chain likely: fewer strikes, wide spreads, sparse OI. Expect LIMITED or OFF readiness on chain-dependent panels; that is correct behaviour.
- No DVOL or crypto GEX: those inputs are switched off with a label.
- News overlay: gold-relevant macro events (US data, Fed).

---

## 7. History and calibration

- My ~2.5 years of history is BTC only. ETH and XAUT collection starts on day one.
- If the Delta API provides historical candles for these instruments, backfill them through the same Quality Gate. Never fabricate history.
- History-based panels state progress: "History: N of 60 days".
- Per-asset thresholds are fitted after enough data, and the panel badge moves from LIMITED to FULL only then.

---

## 8. Monitoring

- **System Health panel:** per asset — feed status, last tick age, ticks per minute, quality-flag counts, gaps in last 24h, rate-limit headroom, reconciliation status.
- Alerts (Telegram) when a feed is down more than X minutes, reconciliation fails, or quality FAIL rate spikes.
- Check Delta rate and subscription limits before adding streams; batch subscriptions; back off on errors.

---

## 9. Testing

- **Golden replay:** record one full BTC day before refactoring. After the refactor, replay it and confirm every BTC metric is unchanged.
- **Switch test:** switch BTC → ETH → Gold → BTC rapidly 20 times; no panel may show another asset's data.
- **Fault injection:** kill the feed, send stale quotes, crossed books, a missing expiry, a fake price spike; each must produce the right WARN/FAIL/OFF behaviour, never a wrong number.
- **Reconciliation test:** paper and (read-only) live P&L match exchange figures for each asset.
- **24h soak test:** all three assets collected for 24 hours with no gaps and no memory growth.

---

## 10. Phases and acceptance

1. **Registry + Quality Gate + BTC refactor** — Done when the golden replay matches and BTC panels look unchanged.
2. **Readiness engine + System Health panel** — Done when every BTC panel shows FULL and fault injection flips badges correctly.
3. **ETH** — Done when all panels work for ETH, switch test passes, readiness badges are honest.
4. **Gold (XAUT)** — Done when panels show correct data or clear LIMITED/OFF reasons, never errors or fake numbers.
5. **Per-asset Strangle Pulse cohorts and algo** — off by default; enabled by me per asset.
6. **Calibration** — per-asset thresholds fitted; badges move to FULL where justified.

After each phase: summary, files changed, test results, known limits.
