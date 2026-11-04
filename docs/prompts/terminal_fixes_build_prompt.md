# Fix Prompt — Terminal Corrections (P&L, API keys, 24/7 sessions, IV sessions, alerts)

Paste this into Antigravity, or save it in the repo root and tell the agent to follow it.

---

## 0. Ground rules for the agent

You are a senior trading-systems engineer working on my live BTC options terminal (Delta Exchange India). Real money runs through it, so correctness comes before speed.

1. **Explore first.** Before changing anything, read the existing panels and code paths for: Trade Desk (chart + floating P&L), the "trade only" and "trade + read-only" sections, P&L Analysis, API key handling, the Ask-me chat box, Strike Picker, algo engine, paper trading, the GoGo zone indicator, IV vs Clock, the usual-IV-fall view, the news overlay, the "Best" indicator, and the theme switch.
2. **Write a diagnosis report** for every issue below: what is wrong, the root cause in the code (file and function), and the proposed fix. Wait for my approval before coding.
3. **Never place, modify or cancel an order** while testing. Test on paper mode or with read-only keys.
4. **Verify every Delta Exchange API endpoint and field in the official docs** before using it. Do not guess names.
5. **One delta rule everywhere:** strikes are selected only between **0.10 and 0.15 absolute delta**. Never below 0.10, never above 0.15 — in live, paper, algo and Strike Picker. If no strike is in the band, take no trade and say why.
6. **Time restrictions apply only to the algo** (and to paper trading only when I set a condition there). Every other panel runs **24/7**.
7. Ship behind a feature flag where a change touches the live algo, so I can switch back.
8. Fix in the priority order of section 12. After each group: summary of changes, files touched, how to test, known limits.

---

## 1. API keys not working (main read-only + sub-account read+trade)

**Setup:** two keys.
- **Main account:** read-only key.
- **Sub-account:** read + trade key.

**Problem:** P&L does not load or update correctly for either key.

**Required:**
- Diagnose the real cause. Check at least: correct India base URL, request signature and timestamp drift, key permissions, IP whitelisting (the server's outbound IP must be whitelisted on Delta), rate limits, and which account each WebSocket subscription is bound to.
- Each key is tracked as a separate account with its own positions, orders, fills, wallet and P&L. Never mix them.
- The read-only key must never be used for an order call; enforce this in code.
- Add a **Key Health** indicator per account: connected / auth failed / IP not whitelisted / rate-limited / stale, with the last successful update time.

**Done when:** both accounts show live positions and P&L, and a broken key shows a clear reason instead of silently showing nothing.

---

## 2. Accurate P&L everywhere (live, sub-account, paper, algo, bot)

**Problem:** P&L figures are misleading and do not match Delta Exchange.

**Required:**
- **Live P&L is built from exchange fills**, not from estimated prices: actual fill price, quantity, side, and the exchange-reported fee for each fill. Unrealized P&L uses the exchange mark price.
- Show per trade and per account: realized P&L, unrealized P&L, total fees (including GST as charged), and **slippage** = fill price vs the mark/mid at the moment the order was sent.
- **Paper and algo P&L** use the same formulas with simulated fills: sell at bid, buy at ask, plus the same fee schedule, so paper never looks better than live.
- Label every P&L with its source: LIVE-MAIN, LIVE-SUB, PAPER, ALGO, BOT.
- **Reconciliation check:** compare terminal P&L with the exchange's own figures (positions/fills/wallet). Show a warning if they differ by more than a small tolerance.

**Done when:** for a test trade, the terminal's realized P&L, fees and net match Delta Exchange's own records.

---

## 3. Tick-by-tick P&L recording (P&L Analysis)

**Required:**
- From the moment a trade opens, record P&L **on every tick** (every mark price or position update) for each open trade and each account.
- Recording runs **on the server**, not in the browser, so it never stops when the screen is off.
- Store per tick: timestamp, account, trade id, mark price per leg, unrealized P&L, realized P&L, fees so far, net P&L, delta, gamma, theta, vega.
- P&L Analysis shows a **continuous P&L line** per trade with:
  - **Peak P&L** (highest point) with time — marked on the line
  - **Max drawdown** (lowest point and the largest fall from a peak) with time — marked on the line
  - Current P&L, time in trade, and distance from peak
- Chart downsamples for display but keeps full tick data in storage.

**Done when:** a trade's P&L line is unbroken from entry to exit, and peak and max-drawdown markers match the stored ticks.

---

## 4. Floating P&L on the Trade Desk

**Problem:** the floating P&L on the chart does not work properly, and after the screen turns off it shows "last update 13 seconds ago" and stale values.

**Root-cause hints to verify:** browsers throttle timers and can pause WebSockets in hidden tabs; the panel may depend on browser-side polling.

**Required:**
- Floating P&L works in **both** the "trade only" section and the "trade + read-only" section, for each account.
- Server keeps the live state (section 3). The browser only displays it.
- On `visibilitychange` (screen back on) and on WebSocket reconnect, **immediately resync** from the server, then continue streaming.
- WebSocket heartbeat and auto-reconnect with backoff.
- Show a stale badge only if the **server** data is actually stale, with the real age.

**Done when:** lock the screen for 10 minutes; on unlock, P&L is correct within 1 second and the P&L line has no gap for that period.

---

## 5. GoGo zone indicator — record the path and make it position-aware

**Problem:** the indicator redraws a single line. When the market moves away and comes back 30 minutes later, the earlier extreme is overwritten, which is misleading.

**Required:**
- **Record a point every 15 minutes** and keep it. Draw the full path; never overwrite past points. Mark the highest and lowest points reached, with time.
- Add **live position data** from the open trade: live P&L, net delta, gamma, theta.
- **Position-aware cooling:** when the market spikes one way and then returns, and the open position's P&L is recovering (theta and mean reversion working), the indicator should **cool down** instead of staying high on momentum alone. Base this on P&L trend + delta normalising + realized move fading, with hysteresis so it does not flicker.
- Show a clear **HOLD / EXIT** read for the open trade, with the top reasons.

**Done when:** replaying a day where price moved away and came back shows the full 15-minute path, the extreme marked, and the indicator cooling as the position recovered.

---

## 6. Session-wise usual IV fall (replace the current "usual fall")

**Problem:** the current usual-IV-fall figure is not correct and not session-based.

**Required:**
- Define sessions in **one config file** (IST), for example Asia, London, Delta settlement (17:30 IST), New York. Split each session into **first half** and **second half**. Use my example as a starting window: from 05:30 to 08:30 is the first half and from 08:30 to 12:30 is the second half; let me edit all windows.
- From historical IV data (I have about 2.5 years of BTC options IV), compute for each session half: median % IV change, 25th and 75th percentile.
- **Live view:** at each session open, mark the starting IV. Show:
  - expected fall for this half (median and range),
  - actual fall so far,
  - **room remaining** = expected − actual.
- **Warning:** if IV has already fallen more than the 75th percentile early in the session, show "IV near base — consider entering later".

**Done when:** for a past day, the view shows the expected fall per half and the actual fall matches the stored IV data.

---

## 7. Elevated IV tracker — why IV is not falling, and which session usually crushes it

**Required:**
- Flag **elevated IV** when IV stays above its session baseline (e.g. above the 75th percentile for that hour) and is flat or rising.
- Show the **IV sequence by session** for the last 24–48 hours: Asia → London → settlement (17:30 IST) → New York, with the IV change in each.
- From history, compute: **when IV is elevated at the start of a session, how often each later session crushed it** (Asia, London, NY), and by how much. Show this as "most likely crush session" with its historical hit rate.
- Show **likely reasons** IV is holding, from terminal data only: realized volatility still high, scheduled news ahead, settlement approaching, weekend, skew stretched, no move yet in the expected session.

**Done when:** on a day with IV holding through NY into Asia, the panel shows elevated status, the session sequence, and the historically most likely crush session.

---

## 8. Insufficient balance / margin alerts (trade-enabled sub-account)

**Required:**
- Before any order (Ask-me panel, algo, bot), check available margin from the exchange. If not enough, block the order and show: **"Insufficient balance — please add funds."**
- While the algo runs, monitor margin continuously. Alert when margin left is not enough for the next planned trade, and at configurable warning levels (e.g. margin used 70% / 85%).
- If the exchange rejects an order for margin, show the exchange's reason in plain words — never fail silently.

**Done when:** an order larger than available margin is blocked with a clear message, and a low-margin state during algo running raises an alert.

---

## 9. Remove time locks — 24/7, session-wise

**Required — remove these restrictions:**
- Strike Picker lock at **1:30** and the **7:00** lock → Strike Picker runs 24/7.
- **IV vs Clock** starting only at **9 PM** → runs 24/7, broken down by session.
- **News overlay** covering only New York → covers Asia, London and New York, with known events shown on the chart for every session the same way it does for NY today.
- **"Best" indicator** observing only New York → runs 24/7, session-wise.
- Any other panel with a hard-coded time window → 24/7.

**Keep:** time rules inside the **algo** exactly as configured, and in **paper trading only when I set a condition**. Nothing locks the P&L or freezes a delta pick.

**Never lock the strike pick:** Strike Picker keeps re-evaluating continuously and always stays within 0.10–0.15 delta.

**Done when:** at any hour of the day, every panel above updates live, and the algo still respects its own time rules.

---

## 10. Theme switch on every panel

**Problem:** the theme switch does not apply everywhere.

**Required:** every panel, chart, modal, chat box, alert and indicator follows the theme switch (light and dark). Replace hard-coded colours with theme tokens. Charts must redraw with the new colours without a reload.

**Done when:** switching theme updates every screen in the terminal with no leftover colours.

---

## 11. Algo entry/exit tracking and Ask-me responsiveness

**Full-screen alerts:**
- When the algo **enters** a real trade: full-screen alert with time, account, strikes, delta, lots, credit.
- When the algo **fully exits**: full-screen alert with time, exit reason, realized P&L net of fees.
- Alerts need a tap to dismiss, play a sound, and are logged.
- Add an **Algo Activity log**: every entry, adjustment and exit with timestamps, markable on the P&L line.

**Ask-me chat box — never look stuck:**
- Every command shows real states: sending → **"Please wait"** spinner with a running **timer** → ✓ done / ✗ failed with reason.
- Spinner appears within 200 ms. For orders, ✓ only after the exchange acknowledges.
- After a timeout (e.g. 15 s), query the real order status and report it; never assume.
- Disable the same button while its order is in flight to prevent duplicates.

**Done when:** an algo entry and exit each raise a full-screen alert and appear in the log, and every Ask-me command shows a timer until it resolves.

---

## 12. Priority order

1. API keys and Key Health (section 1)
2. Accurate P&L and reconciliation (section 2)
3. Server-side tick recording and floating P&L with screen-off fix (sections 3–4)
4. Margin alerts and Ask-me status (sections 8 and 11)
5. 0.10–0.15 delta rule everywhere and removal of time locks (rule 5, section 9)
6. GoGo path recording and position-aware cooling (section 5)
7. Session-wise IV fall and elevated IV tracker (sections 6–7)
8. Algo full-screen alerts and activity log (section 11)
9. Theme switch everywhere (section 10)
