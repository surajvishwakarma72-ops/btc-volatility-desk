# Build Prompt — 24/7 News Alerts + Strangle Rule Book + Market Psychology (one package)

This prompt has three parts, built together:
- **Part A (sections 0–7):** 24/7 breaking news and shock alerts.
- **Part B (section 8):** an in-terminal **Rule Book** panel for short strangle trading, wired into the panels it talks about.
- **Part C (section 9):** **Market Psychology** — session, day-of-week and expiry behaviour — shown in the terminal and used by the news and entry gates.

Paste this into Antigravity, or save it in the repo root and tell the agent to follow it.

---

## 0. Goal and ground rules

I learn about market-moving events (exchange hacks, outages, regulatory shocks, macro surprises) hours late, from social media. Build a **24/7 news and shock-alert system** inside the terminal that:

1. Pulls Bitcoin, crypto-market and stock-market news continuously from several sources.
2. Detects **high-impact events** (hacks, exploits, exchange outages, withdrawal halts, depegs, regulatory actions, macro surprises, war/geopolitical shocks).
3. **Pops up on screen immediately** — day or night — and also sends Telegram (and later the voice assistant speaks it).
4. Tells me what it means for my short strangle: **"Consider closing open positions"** and **"No new entries"** — but **never closes or blocks trades automatically** unless I enable that per rule.

Rules for you (the agent):
- Explore first: find the existing news overlay (today it covers only New York), the alert system, Telegram integration and the algo's entry gate. Plan, then wait for approval.
- Verify each data source's terms, rate limits and API format before using it. Prefer official APIs and RSS feeds; do not scrape sites that forbid it.
- Secrets (API keys, Telegram token) from environment variables only.
- Runs on the **server**, 24/7, independent of whether the terminal is open.

---

## 1. Sources (use several; no single source is fast or complete)

| Layer | Examples to evaluate | Why |
| --- | --- | --- |
| Crypto news aggregators | CryptoPanic API, Free Crypto News API, RSS from major crypto outlets | Broad coverage, tagged by coin |
| General / macro news | Google News RSS queries (e.g. "Bitcoin", "crypto exchange hack", "Fed", "CPI"), major wire-service RSS | Stock-market and macro shocks |
| Security / exploit trackers | Public feeds or RSS from blockchain security firms; exchange status pages | Hacks often surface here first |
| On-chain flows | Whale Alert API (large transfers, exchange inflows/outflows) | Abnormal flows from exchange wallets can precede a hack announcement |
| Economic calendar | Scheduled US releases (CPI, NFP, FOMC, PCE, jobless claims), Fed speakers | Known events, all sessions |
| **Market anomaly detector (own data)** | BTC price, DVOL/IV, funding, OI, liquidations from the terminal's own feeds | Price and IV often move before the headline — this is the fastest signal |

---

## 2. Event classification

Each item gets: source, time, headline, link, assets affected, category, **severity**, deduplication key.

| Severity | Examples | Action |
| --- | --- | --- |
| **CRITICAL** | Major exchange hack/exploit, withdrawal halt, stablecoin depeg, exchange insolvency, sudden regulatory ban, war/attack headline | Full-screen red popup + alarm sound + Telegram + voice. Message: "Consider closing open positions. No new entries." |
| **HIGH** | Large unexpected macro surprise, ETF/regulatory decision, big liquidation cascade, BTC move > N× normal in 15 min with no headline yet | Full-screen amber popup + Telegram |
| **MEDIUM** | Scheduled high-impact release within 60 min (CPI, NFP, FOMC) | Banner + countdown on chart, all sessions |
| **LOW** | General crypto/stock news | News feed only |

Classification:
- Keyword and entity rules first (hack, exploit, drained, breach, halted withdrawals, depeg, insolvency, ban, SEC, Fed, war, plus exchange names such as Binance, Deribit, Coinbase, OKX, Bybit, Delta).
- Optional LLM classifier for headline severity, but rules decide CRITICAL; the LLM may only upgrade to review, never downgrade a rule hit.
- **Deduplicate** the same story from many sources into one event with a source count; a story confirmed by 2+ independent sources gets a "Confirmed" badge.
- Mark single-source CRITICAL items as **"Unconfirmed — verify"**, still alerted, because speed matters.

---

## 3. Anomaly-first alerts (before the news)

Fire a **HIGH "Unexplained move"** alert when any of these happen without a matching headline:
- BTC moves more than N× its recent 15-minute volatility.
- DVOL/ATM IV jumps more than X points in 15 minutes.
- Liquidations or exchange outflows spike far above normal.
- Funding or basis flips sharply.

When a matching headline arrives later, link it to the anomaly alert.

---

## 4. Popup and terminal integration

- **Full-screen popup** for CRITICAL/HIGH, on any panel, any time: severity colour, headline, source(s), time since event, linked price/IV move, and two buttons: **Open positions** (jumps to P&L/positions) and **Acknowledge**.
- Popup stays until acknowledged; sound repeats every 60 s for CRITICAL until acknowledged.
- **News timeline on the chart** for **all sessions** (Asia, London, New York): every event drawn as a marker at its time, coloured by severity, clickable for details. Replaces the NY-only overlay.
- **Upcoming events strip**: next 48 h of scheduled releases with countdown, in IST.
- **Strangle Pulse / regime gate integration**: CRITICAL or HIGH in the last X hours adds a **news veto** (verdict → AVOID); MEDIUM within 60 min adds a caution.
- **Algo integration (config, off by default)**: on CRITICAL, block new algo entries automatically; closing positions automatically requires a separate explicit setting.
- Browser notifications + Telegram so I am alerted even when the terminal is closed or the screen is off.

---

## 5. Reliability

- Poll or stream every source on its allowed cadence; target **< 60 s** from first source publication to popup.
- Per-source health in the System Health panel (last item time, errors).
- If all news sources fail, show a banner: "News feed down — alerts unavailable."
- Store all events for later review and for backtesting the news veto.

---

## 6. Testing

- Replay past known incidents (exchange hacks, depegs, CPI surprises) from stored headlines; each must produce the right severity and popup.
- Duplicate stories from 5 sources produce one popup, not five.
- Screen-off test: event fires while the terminal tab is hidden → Telegram arrives and the popup is waiting on return.
- No false CRITICAL from ordinary headlines containing "hack" in another sense (e.g. "growth hack") — tune rules.

---

## 7. Phases

1. Sources + storage + deduplication + news feed panel.
2. Classification + CRITICAL/HIGH full-screen popups + Telegram.
3. Anomaly detector (price/IV/liquidations) linked to headlines.
4. 24/7 chart timeline for all sessions + upcoming-events strip.
5. Strangle Pulse news veto + optional algo entry block.
6. Replay testing and tuning.

After each phase: summary, files changed, how to test, known limits.

---

## 8. Part B — Short Strangle Rule Book panel

### 8.1 What to build

- A **Rule Book** panel reachable from the main menu, from a "?" icon on every panel (opening the rule section for that panel), and by voice ("नियम बताओ", "rule book").
- Content lives in **one editable Markdown/JSON file** (`rulebook/`), so I can change rules without code. Sections below are the initial content.
- **Live rule checks, not just text:** the Before-Entry checklist (8.5) is computed from live terminal data and shown as green / red ticks in the Ask-me panel before any order. A red tick shows the rule it breaks. For manual orders: warn and require a second confirmation. For the algo: block the entry.
- **Rule-break log:** every order placed with a red tick is logged as a rule break and counted in P&L Analysis. After a rule break, the panel shows "Half size for next 5 trades" and the Strike Picker suggests half size.
- **Daily stop:** after 2 rule exits in a day or a 3% equity loss, Ask-me shows a full-screen "Daily stop reached" and requires a typed confirmation to trade again.
- **Journal:** after every exit, prompt a short journal form (fields in 8.9), saved and viewable in P&L Analysis.
- The Rule Book shows a note at the top: *"No rule set is foolproof or guarantees profit. Patterns are tendencies; verify them with the terminal's own history."*

### 8.2 Why the strategy works (top of the panel)

A short strangle earns because options usually price more movement than BTC delivers (implied volatility above realized volatility most of the time). Sellers lose in the rest of the time and in rare shocks, so the rules focus on staying out then, sizing small, and exiting by rule.

### 8.3 First 5 minutes — open panels in this order (stop at any failure: no trade)

1. System / Key Health — all feeds and keys green and fresh.
2. News and events — no CRITICAL/HIGH recently; no CPI/NFP/FOMC in the next 60 min.
3. Regime gate — IV/RV > 1.3, ADX < 15, no killer pattern (RVP and ADX rising together), DVOL not spiking.
4. Strangle Pulse — SELL NOW / Sell Zone only. *(Until live: last 2–3 h moved less than IV priced, both chain sides decaying.)*
5. IV vs Clock + session IV fall — room left for IV to fall this session.
6. Elevated IV tracker — if IV is holding, which session usually crushes it.
7. BTC chart with GEX and max pain — strikes vs gamma walls and big OI.
8. GoGo zone indicator — zone path and HOLD/EXIT.
9. Strike Picker — 0.10–0.15 delta, spreads, credit.
10. Ask-me — place order; wait for the confirmed tick.

### 8.4 Hard rules

1. Strikes only between 0.10 and 0.15 delta (live, paper, algo).
2. Sell the N2N expiry; skip the two nearest.
3. No entry without both gates: regime gate + Strangle Pulse SELL NOW.
4. No entry on NO DATA, red Key Health or stale feed.
5. No entry within 60 min before CPI/NFP/FOMC, nor for hours after a CRITICAL/HIGH alert.
6. Exit at 1:1: close when loss equals the profit target; never move the exit further away.
7. Never add to a losing short or average a tested leg.
8. Keep the 20% safety buffer (SAFETY_BUFFER_PCT = 0.20) untouched.
9. Risk per trade at most 1–2% of equity at the exit level; half on weekends and event weeks.
10. Spread veto: no entry if either leg's spread > 10% of its premium.
11. Daily stop: after 2 rule exits or a 3% equity loss in a day.
12. CRITICAL news while in a trade = close first, then read.
13. Journal every trade within the hour.
14. Rule broken → half size for the next 5 trades.

### 8.5 Before-entry checklist (computed live in Ask-me)

Key Health green · no CRITICAL/HIGH news · no top-tier release within 60 min · IV/RV > 1.3 · ADX < 15 · no killer pattern · Strangle Pulse SELL NOW · room left in session IV fall · term structure not inverted and no IV kink on the chosen expiry · both strikes in 0.10–0.15 delta and beyond the nearest big gamma wall · spreads < 10% · size within 1–2% risk and 20% buffer intact · exit levels in BTC price shown for both sides.

### 8.6 In-trade checks (every 15 min) and exit table

Watch: floating P&L vs peak/drawdown · Strangle Pulse zone and GoGo · leg balance (tested leg delta > 0.30 = warning) · Delta Stability (delta jumping on small moves) · IV trend (rising IV + rising RV) · OI on own strikes (premium up + OI up = buyers pushing) · news and spreads.

| Signal | Action |
| --- | --- |
| Loss reaches 1:1 exit level | Close both legs |
| CRITICAL news popup | Close both legs |
| Killer pattern forms | Close both legs |
| Zone → Avoid, or GoGo EXIT | Close, or halve if still profitable |
| Tested leg delta > 0.30 | Close tested leg; keep other only if zone still Sell |
| Most premium collected | Take profit |
| Top-tier release approaching while in profit | Take profit or halve |
| Spreads > 10% | Reduce while exits are still fair |

Show this table as live alerts: when a signal fires, the matching action pops up.

### 8.7 Sizing, margin, liquidation

- Lots = (Equity × Risk per trade) ÷ (Loss per lot at the exit level, incl. fees and slippage, using contract value from the asset registry). Round down; < 1 lot = trade too big.
- Margin rises as BTC nears strikes and as IV rises; keep the 20% buffer; margin alerts at 70% and 85% used.
- The 1:1 exit must always trigger well before liquidation; if not, size is wrong.
- Algo and manual trades on one account are sized together.

| Situation | Risk per trade |
| --- | --- |
| Normal weekday, all gates green | 1–2% |
| Weekend or top-tier release this week | 0.5–1% |
| After a rule break (next 5 trades) | Half of normal |
| Readiness LIMITED / data doubtful | No trade |

Strike Picker shows the computed lot size from this formula.

### 8.8 Daily routine

Start of day: Key Health, last 12 h news, week's release and expiry calendar → before entry: full checklist → in trade: 15-min checks → after exit: journal → weekly review: win rate, average win vs loss, rule breaks, gates followed vs overridden.

### 8.9 Journal fields

Date/session/day · expiry and strike deltas · gate readings (IV/RV, ADX, Strangle Pulse verdict/confidence, news status) · lots and risk % · exit time, reason, net P&L, peak and max drawdown · rules broken and why · one-line lesson.

---

## 9. Part C — Market Psychology (sessions, days, expiries)

### 9.1 What to build

- A **Market Psychology** tab inside the Rule Book, plus a live **"Today" card** on the main screen showing: current session, day-of-week note, next expiry/settlement times, upcoming releases, and the matching rule (e.g. "Monday: no entry before NY open settles").
- All times in **IST**, with automatic shift when the US changes daylight saving (from mid-March to early November US events move 1 hour earlier in IST).
- Every pattern below shows a **"Verified by your data"** badge once the terminal's own history confirms or rejects it (hit rate and sample size). Until then: "Unverified tendency".
- Day-of-week, session and expiry rules feed the entry gate as **warnings** (not hard blocks), except where section 8.4 makes them hard rules.

### 9.2 Sessions (IST, winter)

| Session | IST | Behaviour | Approach |
| --- | --- | --- | --- |
| Asia | 05:30–13:30 | Moderate, often range-bound | Good for decay; thinner premium |
| Quiet hours | ~11:30–13:30 | Least active | Hold; poor fills for entry |
| London | 13:30–22:30 | Liquidity rises, directional moves start | Don't enter into London open |
| London + NY overlap | 19:30–22:30 | Highest volume and volatility; research peak ~21:30–22:30 | US data at 19:00; never enter just before |
| New York | 19:30–04:30 | Institutional, macro-driven | Prime entry ~21:00–22:30 after NY open settles |
| Late US | 01:30–05:30 | Thin, wide spreads | Hold, don't enter; FOMC ~00:30 |

Fixed times: Delta settlement 17:30 IST daily · Deribit settlement 13:30 IST Fridays (08:00 UTC) · US data 19:00 IST (18:00 in US summer) · FOMC statement ~00:30 IST, press conference ~01:00.

My own IV rhythm hypothesis: Asia lifts IV → London crushes it → Delta 17:30 settlement brings a new rise → New York crushes it. Measure it with the session IV fall panel and show how often it holds. When IV stays elevated across NY into Asia with no move, show which session historically releases it and advise waiting for that session.

### 9.3 Day-of-week

Research on BTC day-of-week effects is real but inconsistent (studies variously find Monday/Friday or Monday/Thursday volatility effects; others find markets largely efficient). CME moved to 24/7 crypto futures from 29 May 2026, so the old weekend gap is fading; Monday is now about whether returning institutional/ETF liquidity confirms the weekend price.

| Day | Tends to happen | Crowd psychology | Rule |
| --- | --- | --- | --- |
| Monday | Weekend price tested; sharp moves on returning liquidity | Weekend orders, hedges, ETF flows meet at once | Risk is the weekend being repriced. If Asia already moved and settled → repricing done, normal gates from London on. If Asia was quiet too → wait for NY open to settle. Sell Wednesday expiry. (Terminal detects "repricing done" from Asia range vs baseline.) |
| Tuesday | Often calmer after Monday repricing | Positioning done; focus on the week's data | Good entry if calendar clear; check CPI |
| Wednesday | Mid-week; FOMC lands ~00:30 IST Thursday | Market freezes before Fed, releases after | No fresh strangle into FOMC unless IV prices it |
| Thursday | Positioning and rolls before Friday's Deribit expiry | Dealer hedging can pin or accelerate near big strikes | Sell Saturday expiry; must survive Friday settlement, Friday data, Saturday thin market |
| Friday | Deribit settles 13:30 IST; NFP first Friday 19:00 IST | Pin before, release after; funds sell weekend vol | No entry just before 13:30 or 19:00; check IV crush vs expansion after settlement |
| Saturday | Thin books | Institutions away; weekend headlines with TradFi shut | Half risk |
| Sunday | Thin until Monday Asia; evening re-hedging | Positioning for the week | Exit weekend trades on plan; don't carry into Monday open |

Month-end and quarter-end Friday expiries are bigger → stronger pin and release around 13:30 IST.

### 9.4 Expiry selection (N2N)

Gamma rises sharply near expiry, so skipping the two nearest trades some fast theta for calmer strikes.

| Entry | Expiry sold | Must survive | Watch |
| --- | --- | --- | --- |
| Monday | Wednesday | Monday repricing, mid-week US data, FOMC weeks | Enter after Monday NY open settles |
| Thursday | Saturday | Friday Deribit settlement, Friday data (NFP), Saturday thin market | Richer premium = pay for real weekend risk |
| Fri/Sat night | Monday (weekend strangle) | Weekend headlines | Half size; exit by planned morning time |

Around big expiries: hedging can pin price near large OI strikes before settlement; max pain is a weak magnet with a mixed record; after settlement hedges vanish — near max pain often → IV crush, otherwise price can break free. An **IV kink** (one expiry priced above its neighbours) means a specific event is priced on that date: size down or choose another expiry. Show kinks automatically on the term-structure view and in the Before-entry checklist.

### 9.5 Market and trader psychology (shown as short cards)

Crowd:
- Thin books (weekends, late US, quiet Asia) get pushed around; stop-runs are easier.
- Leverage (perps up to 200x) feeds liquidation cascades; sellers are hit by the 2nd and 3rd wave.
- Fear is priced into puts after sell-offs; fat put premium appears exactly when risk is highest.
- Events are bought then dumped: IV rises into CPI/FOMC/expiry and often collapses after — sell after, not before.
- Pins are temporary: big OI strikes attract price into settlement, then release it.
- Sellers are crowded too: when everyone is short vol, a surprise forces mass buy-backs.

Trader:
- Winning streaks invite bigger size; the next trade is where accounts break — size fixed by rule.
- "It will come back" turns a 1:1 loss into 5:1 — exit level is set before entry.
- Revenge trading after a stop skips the gates — daily stop exists for this.
- FOMO selling because premium looks fat — find out why it is fat first.
- Rule drift — every break journaled, half size for 5 trades.

Link each card to the panel that detects it (e.g. "liquidation cascade" → news anomaly detector; "event premium" → term structure kink).

### 9.6a Silence & Compression engine (quiet before the storm)

Purpose: decide what to do when sessions stay quiet for days — sell, wait, or prepare to sell after the break.

Background shown in the panel:
- Volatility clusters (calm follows calm short-term) but also mean-reverts, faster in crypto; compression can last months.
- Extreme compression (tight Bollinger bandwidth, IV index lows) has preceded big BTC moves in either direction, but band width alone does not time the break.
- Quiet usually means cheap premium; selling low IV rank gives little reward and no cushion.

Build:
1. **Silence counter per session** (Asia, London, NY), weekdays only:
   - A session is "quiet" when its range is below the 30th percentile of its own 60-day **weekday** baseline.
   - **Saturday and Sunday sessions are never counted** (thin by nature). Sat + Sun + Mon quiet London = counter 1.
2. **Compression level** shown as a badge and fed to the entry gate:

| Level | Definition | Gate effect |
| --- | --- | --- |
| Normal | Session range ≥ 30th pct of its weekday baseline | None |
| Quiet | 1–2 consecutive quiet weekdays for that session | None (quiet helps the strangle) |
| Coiled | 3–4 consecutive quiet weekdays for that session, OR all three sessions quiet on one weekday with daily RV in bottom 20% | Entry only if IV/RV ≥ 1.3 AND IV percentile ≥ 40; suggest half size, strikes near 0.10 delta; block expiries spanning a top-tier release |
| Squeeze | 5+ quiet weekdays, OR daily range at 20-day low + Bollinger bandwidth bottom 10% of the year + IV percentile < 20 | Block new strangles (manual: warning + second confirm; algo: block) |

3. **IV-behaviour read during silence:**

| Price quiet, IV… | Label | Action shown |
| --- | --- | --- |
| Stays high (IV/RV well above 1.3) | "Market paying for an expected move" | Show nearest scheduled event; if none, "Overpaid — half size allowed" |
| Falls with RV (IV/RV ~1.0–1.2, low IV percentile) | "Cheap premium" | "Don't sell — wait" |
| Rises while price flat | "Protection being bought" | "Don't sell; tighten alerts on open trades" |

4. **Dead-IV gate (hard rule):** IV is "dead" when IV percentile < 20, OR IV at its 30-day low, OR IV/RV < 1.1. While dead: badge "DEAD IV — no sale"; manual orders get a warning + second confirmation; algo entries blocked. Applies at every compression level.
5. **Wake-up wave detector (the entry after a silence):** a three-step state machine, shown as a progress strip on the panel:
   - **Wave:** a session range > 70th pct of its weekday baseline AND IV up ≥ 2–3 vol points (or IV percentile back above 40).
   - **Settle:** RV falling for 1–2 h, price holding a range, killer pattern off, no new HIGH/CRITICAL news.
   - **Roll-over:** IV turns down from its wave high (e.g. 1–2 points below the high), ideally at the next session open → show **"Sellable IV — sell the fall"** and pre-fill Strike Picker.
   - First trade after a Squeeze: suggest half size; full size only if the wave plays out with no second leg.
   - If no wave arrives: stay in "Waiting for sellable IV". Never show a sell signal on dead IV.
   All thresholds in config; calibrate from stored history (how often a wave + roll-over entry finished profitable vs selling during the silence).
6. **Tripwires for open trades in Coiled/Squeeze:** draw the quiet range high/low on the chart; if price closes outside it with RV expanding → popup "Compression break — exit, don't wait for 1:1".
7. **Breakout-session statistics:** from stored history, after N quiet weekdays, which session expanded first and how often a scheduled US release was the trigger. Show as "Most likely breaking session". Until enough data: "US data day → NY likely; no event → watch London open and first NY hour."

Worked examples to include as help text:
- London quiet Sat, Sun, Mon → Tuesday counter = 1 → normal rules. If also quiet Thu and Fri → counter 3 (Coiled) → sell Tuesday only with IV/RV ≥ 1.3 and IV pct ≥ 40, half size.
- Monday: Asia moved, London quiet, NY moved → not compressed; one quiet Monday London is common (it waits for NY) → follow Monday rule; best entry after NY move settles.
- All three sessions quiet Mon and Tue with IV falling → Coiled → Squeeze → stop new strangles, set tripwires, prepare post-break sell.

### 9.6 News integration

The news alert levels (section 2) and the rule book's news protocol are one system:

| Level | In a trade | New entries |
| --- | --- | --- |
| CRITICAL | Close both legs now | None until quiet for several hours |
| HIGH | Close or halve | None until move settles |
| MEDIUM (CPI/NFP/FOMC within 60 min) | Take profit or halve | None 60 min before, 30–60 min after |
| LOW | No action | Normal rules |

Rule: when price or IV jumps hard with no headline, treat it as unseen news (anomaly alert, section 3).

---

### 9.7 IV regimes (percentile-based, never absolute)

Compute IV percentile over the terminal's own last 12 months (per asset, per expiry tier). Absolute IV is never used in a rule.

| Regime | IV percentile | Rule | Size |
| --- | --- | --- | --- |
| Dead | < 20 | No sale; wait for wake-up wave | 0 |
| Low | 20–40 | Sell only on a wave roll-over, near 0.10 delta | Half |
| Core | 40–70 | Full rule book | Full |
| Rich | 70–90 | Sell only after spike settles and IV starts falling | Half |
| Crisis | > 90 | No new strangles; manage/close existing | 0 |

Transition alerts (popup + Telegram): Low→Core rising ("tighten exits"), Rich→Core falling ("best sell window"), Crisis→Rich falling 24 h+ with RV falling ("first sellable window, half size"), Dead/Low for 3+ weeks ("compression building").
Context note for the user: his own observed Delta IV bands (20–30 for months, 30–40 for 6+ months, > 60–70 rare) are lower than public 30-day indexes (DVOL floor mid-30s) because they are short-dated OTM strikes — hence percentiles.
Per-regime performance table from his shadow + real trades (win rate, avg win, avg loss); thresholds editable in config.

### 9.8 RV rules

| IV/RV | Rule |
| --- | --- |
| < 1.0 | Never sell |
| 1.0–1.3 | Core zone only, half size |
| 1.3–1.8 | Normal |
| > 1.8 | Find the event; sell after it, or half size if none |

RV behaviour: RV falling on all timeframes → sell; short-term RV rising faster than long-term → no new entries; RV + ADX rising → hard veto and close; RV percentile bottom 10% for weeks → compression rules.

### 9.9 Long and short (futures probe) rules

| Probe shows | Rule |
| --- | --- |
| Winner flips | Sell both sides normally |
| Same side wins 4 of last 6 hours | Trend-side strike 0.10, other side up to 0.15 |
| Same side wins 5–6 of 6 | No new strangle |
| Funding one-sided + OI rising fast | Trend-side strike 0.10, half size (squeeze risk) |
| Large liquidation cluster just beyond a strike | Move that strike out or skip |

Net delta rule: if open strangle's net delta drifts past the equivalent of one leg's 0.20 delta → suggest closing the tested leg.
Add funding rate, OI change and liquidation-level overlays to the probe panel.

### 9.10 Daylight saving engine

- Compute every session from **London and New York local time** (IANA time zones), never from fixed IST times.
- 2026–27 phases (IST): winter (1 Nov 2026–13 Mar 2027): London 13:30, NY 20:00, US data 19:00, FOMC ~00:30 · US moved, UK not (14–27 Mar 2027): London 13:30, NY 19:00, data 18:00 · summer (28 Mar–30 Oct 2027): London 12:30, NY 19:00, data 18:00 · UK back, US not (31 Oct–6 Nov 2027): London 13:30, NY 19:00, data 18:00. Fixed: Delta 17:30, Deribit Fri 13:30.
- Rules: summer US data days → no entry 17:30–18:30 IST (settlement reset then data). Winter Fridays → London open and Deribit settlement both at 13:30. Transition weeks → banner "Session times shifted this week". NY entry window shifts: ~21:00–22:30 winter, ~20:00–21:30 summer.
- Algo time rules must be session-relative so they follow DST automatically.

### 9.11 Monthly playbook

| Month | Tendency | Plan |
| --- | --- | --- |
| Jan | Strong avg, liquidity returns | Normal after first week |
| Feb | Strongest avg, trend-prone; Chinese New Year | Half size; trend-side 0.10 |
| Mar | Mixed; quarter-end expiry; US DST | Normal; watch transition weeks |
| Apr | Strong, trend-prone | Half until regime clear |
| May | Positive | Half; fast exits on killer pattern |
| Jun | Moderate; quarter-end expiry | Normal |
| Jul | Moderate, low variation; summer thin | Normal; dead-IV watch |
| Aug | Weakest avg; Jackson Hole | Half around Jackson Hole |
| Sep | Negative, low variation | Normal size, only with sellable IV |
| Oct | Strong, trend-prone ("Uptober") | Smallest size of year; no entry against 4-of-6 trend |
| Nov | Strong; US DST ends | Half until trend clear |
| Dec | Mixed; thin 23 Dec–1 Jan; tax-loss and rebalancing | Normal early; half in holiday week |

User's own last-year results to show alongside (editable): Dec huge profit · Jan genuine profit · Feb stop-loss · May stop-loss · Jun strong · Jul good · Aug/Sep small · Oct bad (two years).
Auto-build a **personal monthly heat map** from his journal/P&L; after 2 years it replaces the research averages in the plan column.

### 9.11a Week-by-week calendar (event-driven, no backtest)

Rate every week Green / Amber / Red from the economic calendar and liquidity, computed automatically for the actual dates of the year:

- **Green:** no top-tier release, normal liquidity → normal rules and size.
- **Amber:** one top-tier event (NFP, CPI, FOMC, Jackson Hole) or thin market (US/UK holiday, summer) → sell after the event settles; half size before it.
- **Red:** 2+ events in the week, quarter-end Deribit expiry, US/UK clock-change week, or holiday-thin (Christmas–New Year, Thanksgiving, Independence Day, Chinese New Year) → half size at most, or wait.

Default monthly shape: W1 NFP (first Friday) · W2 CPI (~10th–15th) · W3 quiet unless FOMC · W4 month-end + Deribit monthly expiry (last Friday; quarter-end in Mar/Jun/Sep/Dec = Red).

Seed table (the terminal recomputes from real dates; FOMC weeks vary by year — pull from the economic calendar):

| Month | W1 | W2 | W3 | W4 |
| --- | --- | --- | --- | --- |
| Jan | Red: holiday-thin + NFP | Amber: CPI | Amber: MLK Monday | Red: FOMC (often) + month-end |
| Feb | Amber: NFP | Red: CPI + Chinese New Year | Amber: Presidents Day | Amber: month-end |
| Mar | Amber: NFP | Red: US DST + CPI | Red: FOMC (often) + triple witching | Red: UK DST + quarter-end expiry |
| Apr | Amber: NFP / Easter | Amber: CPI | Amber: US tax day | Green–Amber: month-end |
| May | Red: FOMC (often) + NFP | Amber: CPI | Green | Amber: Memorial Day + month-end |
| Jun | Amber: NFP | Red: CPI + FOMC (often) | Amber: triple witching | Red: quarter-end expiry |
| Jul | Red: July 4 thin + NFP | Amber: CPI | Green | Red: FOMC (often) + month-end |
| Aug | Amber: NFP | Amber: CPI | Green–Amber: summer thin | Red: Jackson Hole + month-end |
| Sep | Amber: Labor Day + NFP | Amber: CPI | Red: FOMC (often) + triple witching | Red: quarter-end expiry |
| Oct | Amber: NFP | Amber: CPI | Green–Amber | Red: UK DST + FOMC (some years) + month-end |
| Nov | Red: US DST + NFP + FOMC (some years) | Amber: CPI | Green | Red: Thanksgiving + month-end |
| Dec | Amber: NFP | Red: CPI + FOMC (often) | Red: triple witching + pre-holiday | Red: Christmas thin + quarter/year-end expiry |

Personal overlay (editable): best months Dec/Jan/Jun → sell after Red-week events; stop-loss months Feb/May → skip W1 and first half of W2; October → trade size only in W3. Best weeks overall: a Green W3 after CPI has settled.

Feed into the entry gate as warnings (not blocks): Amber → "Event this week: sell after it"; Red → suggest half size. Personal weekly heat map (P&L by week-of-month × month) builds from the journal and is shown beside the calendar.

### 9.11b Calendar sizing (month × week × day)

The calendar only reduces size; max is 1.0 × base, still capped by the 1–2% risk rule. Multipliers are starting values from published BTC volatility studies (Monday/Thursday, Monday/Friday and Saturday volatility effects; widest monthly swings Apr/May/Oct/Nov, narrowest Jul/Sep) plus the event calendar — not a strangle backtest. All in config; replaced by the user's own heat-map data over time.

Month: Jan 1.0 · Feb 0.5 · Mar 0.75 · Apr 0.5 · May 0.5 · Jun 0.75 · Jul 1.0 · Aug 0.75 · Sep 1.0 (only with sellable IV) · Oct 0.5 · Nov 0.5 · Dec 0.75 (1.0 before 20 Dec).
Week: W1 0.75 · W2 before CPI 0.5 / after CPI settles 1.0 · W3 1.0 (FOMC week 0.5, 1.0 after decision settles) · W4 0.75 (quarter-end or holiday-thin 0.5).
Day of entry: Mon 0.5 (0.75 after NY open settles) · Tue 1.0 · Wed 1.0 (FOMC day 0.5) · Thu 0.75 · Fri 0.5 before 13:30 IST settlement or NFP, 0.75 after · Sat 0.5 · Sun 0.5.

Size = base lots × M_month × M_week × M_day, rounded down. Product < 0.25 → skip ("Calendar stacks too many risks"). All other gates still apply.

Build: a **Calendar Sizing card** in Strike Picker and Ask-me showing the three multipliers as chips, the product, and the resulting lots; Strike Picker pre-fills that lot size. In the graphical view, the year planner shades each day cell by its combined multiplier (full / half / small / skip).

### 9.12 Extra rules (from system review)

Minimum credit vs fees + slippage · premium per unit of risk (credit vs distance to strikes in expected moves) · weekly loss limit · streak guard (no size increase for 10 trades after 5+ wins) · 2-hour cooldown after a stop-loss · regime-change alerts · holiday calendar (US, UK, Chinese New Year, Japan) on chart · event-cluster warning (FOMC + CPI + big expiry same week) · Nasdaq and DXY beside BTC in NY hours · halving-cycle year label · personal heat maps (month, weekday, session, IV regime). All thresholds in config.

---

## 9B. Part D — Rule Book UI: Graphical View + Detail View

The rule book must **not** read like an essay. Build two views with a toggle at the top (remembered per user):

### Graphical View (default) — a visual dashboard, minimal words

| Widget | Shows | Click → |
| --- | --- | --- |
| **Verdict lamp** | Big SELL / WAIT / AVOID / NO DATA with top 3 reasons as icons | Detail of each failed rule |
| **Rule traffic lights** | One light per hard rule and gate (green / amber / red), grouped: Data · News · IV · RV · Trend · Size · Time | That rule's detail section |
| **IV regime gauge** | Semicircle dial 0–100 percentile, five coloured bands (Dead, Low, Core, Rich, Crisis), needle = now, ghost needle = 24 h ago (shows transition direction) | Regime table + per-regime performance |
| **IV/RV bar** | Horizontal bar with zones <1.0 / 1.0–1.3 / 1.3–1.8 / >1.8 | RV rules |
| **Compression meter** | Battery-style bar: Normal → Quiet → Coiled → Squeeze, silence counter per session as three small dots rows | Silence rules |
| **Wake-up wave strip** | 3-step progress: Wave → Settle → Roll-over, current step lit | Wave rule detail |
| **Session ring** | 24-hour clock in IST with Asia / London / NY arcs computed for today's DST, overlap shaded, fixed markers (Delta 17:30, Deribit Fri 13:30, US data, FOMC), "now" hand, your entry window highlighted | Session playbook |
| **Week strip** | 7 day chips; today highlighted with its one-line rule icon; expiry you'd sell for today's entry | Day-of-week + expiry rules |
| **Year planner (day · week · month)** | Calendar grid: 12 months × 4–5 week rows, each week cell Green/Amber/Red with event icons (NFP, CPI, FOMC, expiry, holiday, clock change); today's day highlighted; "Next week" card on top with rating and its events; your own P&L dot per week once journaled | Week detail: dates, events with IST times, rule |
| **Month calendar heat map** | 12 tiles coloured by plan (Normal / Half / Smallest), each with your own P&L dot; current month outlined | Monthly playbook |
| **Futures trend compass** | Arrow showing long vs short winner persistence (last 6 hours), funding and OI ticks | Long/short rules |
| **Risk thermometer** | Margin used vs 70% / 85% marks, 20% buffer zone, daily and weekly loss used | Sizing rules |
| **News lamp** | Severity colour of latest event + countdown to next scheduled release | News protocol |
| **Psychology cards** | 6 crowd + 5 trader cards with icon and one line; a card lights up when its detector fires (e.g. revenge-trade warning after a stop) | Psychology detail |
| **Personal heat maps** | Your P&L by month, weekday, session, IV regime | Journal entries behind each cell |

Design rules: icons + colour + shape (never colour alone); numbers only where they matter; every widget clickable to its detail; works on phone width; follows the theme switch.

### Detail View

- The full rule book text (sections 8.2–9.12) with headings, tables and source links, searchable, with a table of contents.
- Each section has a "Show in graphical view" link back to its widget.
- Content from the editable rulebook file; changes appear in both views.

---

## 10. Phases for Parts B and C (after Part A phases 1–6)

7. Rule Book panel with editable content file, "?" links from every panel, voice access.
8. Live Before-entry checklist in Ask-me; algo entry block on red ticks; rule-break log; half-size and daily-stop enforcement.
9. Exit-table live alerts during trades; lot-size calculator in Strike Picker.
10. Journal form after exits and weekly review in P&L Analysis.
11. Market Psychology tab and "Today" card with IST times and DST handling.
12. "Verified by your data" badges: compute hit rates for each session, day and expiry pattern from stored history.
13. Silence & Compression engine (9.6a): silence counter, compression badge and gate effect, IV-behaviour read, dead-IV gate, wake-up wave detector (wave → settle → roll-over), tripwires, breakout-session statistics.
14. IV regime engine with transition alerts and per-regime performance (9.7); RV rules (9.8); futures probe rules with funding/OI/liquidation overlays (9.9).
15. Daylight saving engine — session-relative times everywhere, including algo rules (9.10).
16. Monthly playbook + personal heat maps (9.11), week-by-week calendar with auto Green/Amber/Red ratings and "Next week" card (9.11a), calendar sizing card and day shading (9.11b), and extra rules (9.12).
17. Rule Book Graphical View + Detail View with toggle (Part D).

After each phase: summary, files changed, how to test, known limits.
