# Multi-Asset Terminal: Diagnosis Report (no code changed)

Brief: `multi_asset_terminal_build_prompt.md`. Branch surveyed: `feat/strangle-pulse-phase-3a` on 2026-11-01.
Line numbers are for that branch and will drift. The complete inventory is in the appendices.

## 1. What Delta India lists today

From the public products and tickers APIs. Chain figures are **one snapshot on a Sunday morning IST**, when real gold markets are closed, so they are a first look and not a measurement of normal conditions.

| | BTC | ETH | XAUT |
| --- | --- | --- | --- |
| Options listed | 539 or more | 294 or more | 44 |
| Expiries | 9 | 9 | 2 (no N2N tier) |
| Option settlement | 12:00 UTC | 12:00 UTC | **16:00 UTC (21:30 IST)** |
| Option lot | 0.001 BTC | **0.01 ETH** | 0.001 XAUT |
| Option tick | 0.1 | 0.01 | 0.01 |
| Perpetual | BTCUSD | ETHUSD | XAUTUSD, launched 2026-04-17 |
| Perpetual lot / tick | 0.001 / 0.5 | **0.01** / 0.05 | 0.001 / 0.01 |
| Perpetual taker / maker | 0.05% / 0.02% | 0.05% / 0.02% | **0.01% / 0.01%** |
| Index | .DEXBTUSD | .DEETHUSD | .DEXAUTUSD |
| Daily candle history | 400+ days | 400+ days (400 was the request size) | 199 days, from launch |
| Strike step, nearest expiries | 400 | 40-60 | 10-40 |
| Median spread in the 0.10-0.15 band, by expiry | 2.1-7.6% | 3.5-8.0%, 25.7% on same-day | **19.8-29.3%** |
| One call and one put in band | 5 of 9 expiries | 7 of 9 expiries | 1 of 2 expiries |

What this means:

- XAUT spreads breach the 10% hard veto on both expiries in this snapshot. XAUT Strangle Pulse would show OFF or Observe only. That is correct behaviour under the brief, but it needs re-measuring on a weekday before anyone concludes it.
- On Delta, 5 of 9 BTC expiries have one call and one put in the band, so "no strike in band" is routine and not an edge case.
- History for ETH and XAUT exists as candles only. There is no options IV history, so IV-based panels must collect it from day one. `MARK:<option symbol>` candles are documented, but I did not test whether they work for expired ETH or XAUT contracts.

## 2. Problems that would produce wrong numbers or unsafe behaviour

| # | Severity | Location | Problem |
| --- | --- | --- | --- |
| 1 | **Safety** | `backend/src/services/watch/live-exit.ts:21`, also `routes/algo.ts:234` | `OPTION_SYMBOL` matches only `C/P-BTC-`. A real ETH or XAUT position is invisible to the watcher and HARD EXIT, so it would have no stop protection. "Exit all" and cancel in Ask-me (`live-entry.ts:263,286`) are BTC-only too. **Fix before any non-BTC order is possible.** |
| 2 | **Wrong P&L** | `services/bot/delta-public.ts:149`, `:173` | If the products call fails, `catch` is silent and the fallback lot is 0.001. ETH P&L would be 10x too small with no warning. |
| 3 | **Wrong P&L** | `lib/algo/profit.ts:18`, `algo-engine.ts:241`, `plan.ts:104`, `lib/pulse/config.ts:24`, `index.html:33477` | Lot size of 0.001 is assumed in code. |
| 4 | **Wrong time** | `services/bot/delta-public.ts:52` | `parseExpiry` fixes 12:00 UTC. XAUT would be treated as expired 4 hours early, which breaks DTE, Greek time decay and the cohort roll. Expiry must come from the product's `settlement_time`. |
| 5 | Wrong session | 58 lines in `index.html`, plus Ask-me, glossary, algo rules | 17:30 IST settlement is built in across the desk. |
| 6 | **Existing bug, BTC** | `services/bot/delta-public.ts:163` | `page_size=500`, but BTC alone now has at least 539 options. Symbols past the page silently use defaults. Harmless today only because the defaults equal BTC's real values. |
| 7 | Data collision | `services/pulse/pulse-store.ts:50,108` | `UNIQUE (slot, slot_ms)` and `PRIMARY KEY (grid_ms, slot)` have no asset. A second asset's cohort would collide with BTC's. |
| 8 | Wrong hedge cost | `delta-public.ts:200` | `DEFAULT_PERP` is BTC's fees and lot. On failure XAUTUSD would be charged 5x its real taker fee. |
| 9 | Wrong size filter | `deribit-flow-worker.ts:111` | A "block" is 10 BTC. The threshold means nothing for ETH. |
| 10 | Display-only stripping | `index.html:59462,60466` | `.replace(/-BTC/, '')` would leave ETH and XAUT symbols unclean, and a position's asset unclear. |
| 11 | Margin | `lib/bot/portfolio-margin.ts:4,49,68` | The portfolio margin model is fitted to BTC (leverage, OM% cap). Reusing it for ETH or XAUT would give confident wrong margin. Should be OFF for those assets until rebuilt. |

## 3. Gaps against the brief's architecture

| Brief requires | Today | Consequence |
| --- | --- | --- |
| Server is source of truth | `frontend/index.html` is one 62,339-line, 4 MB file with about 196 timers/IndexedDB/WebSocket matches. 30 lines reach Delta, Binance or Deribit directly from the browser, and IV history collection lives in browser IndexedDB (`index.html:22016,22523,30670`). | The largest piece of work. Browser-collected data stops when the screen is off and cannot serve three assets. |
| One selector, no stale panel | No asset state exists. Modules are about 99 independent blocks, each with its own constants and pollers. 754 BTC-matching lines in the frontend. | Clearing "every panel" needs a shared asset store, and each module must be taught to reset. Otherwise the 20-switch test will fail. |
| Asset Registry | None. `fetchChain` and `paper/market.ts:117-119` are BTC-only. Pulse uses `lib/pulse/config.ts:20`. | Build first, as the base for everything else. |
| Raw store, Quality Gate | Neither exists. Some guards are scattered (Pulse frozen-feed guard, staleness). | New layer. |
| `asset` on every row | Only `trades.underlying` and a few `symbol` columns. No asset column in Pulse, `iv_history`, `shadow_strangles`, `strike_alerts`, `bot_*`, `algo_*`, `paper_strategy_marks`. | Migration with default `'BTC'` for existing rows. Keys must change on Pulse tables. |
| Golden replay of a BTC day | **No recording exists, and raw data is not kept.** | Must record before refactoring. See section 5. |
| Binance inputs | BTCUSDT drives hourly regime bars (`pulse/hourly-bars.ts:11`), Futures lane, candles. | Stays for BTC so the replay matches. Delta index candles cover XAUT. Whether Binance lists XAUT was not checked and is not needed. |
| Deribit inputs | DVOL and flow are `currency=BTC` (`deribit-flow-worker.ts:54,87`, `algo/series.ts:79`, `paper/flow.ts:56`). | ETH works by parameter. XAUT switches these off with a label. |
| Macro lane | Correlation with BTC only (`macro-stress-worker.ts:129`, `lib/macro.ts:68`). | Parameterise. |
| Gold calendar | None. Crypto 24/7 is assumed. | New registry field. |

Research code (`backend/src/backtest`, `backend/scripts`) is BTC on purpose and stays as it is.

## 4. Delta API check

Verified in the official docs (docs.delta.exchange):

- India base URL: `https://api.india.delta.exchange`. The global URL must not be used.
- REST quota: 20,000 units per 5 minutes. Tickers, products, orderbook and candles cost 3 units each. A 429 is returned over quota.
- Candles: 2,000 per response. `MARK:`, `OI:` and `FUNDING:` prefixes are documented, with `OI:ETHUSD` as an example.

**Not verified:** WebSocket option subscription rules (symbol limits, wildcards, connection limits). The docs page came back truncated before that section. This must be confirmed before Phase 3 adds streams. REST capacity is not a concern: polling all three chains each minute is a small part of the quota.

`settlement_time` is undefined in the docs but appears in live product data as an ISO time, which is what section 1 uses.

## 5. Risks and the recommended order

1. **Recorder first.** The golden replay needs one full BTC day recorded from the current code before refactoring. That needs a small recorder deployed to the VM. It writes only to its own store.
2. **Raw store location.** Every chain once a minute is roughly 877 symbols x 1,440 = 1.26M rows a day. That is far too heavy for the Neon Postgres database. Recommendation: compressed daily files on the VM's disk, with Neon keeping only clean aggregates. VM disk space and Neon limits still need checking.
3. **Merge order.** `feat/strangle-pulse-phase-3a` is 25 commits ahead of `main` and touches the same Pulse tables. Finish or merge it before Phase 1, or the asset migration will conflict.
4. **Overlap with `terminal_fixes_build_prompt.md`.** Its P&L, key health and server-side tick recording (sections 1-4) are the same code as Phase 1's P&L and reconciliation work. Multi-asset P&L built on P&L you already call misleading would carry the fault to three assets. Recommendation: do fixes sections 1-3 first, or fold them into Phase 1.
5. **Frontend size.** Converting all modules in one pass is not realistic to verify. Recommendation: move panels in groups behind the asset store. A panel not yet converted shows OFF ("BTC only for now") on ETH and Gold, which satisfies the rule that no panel shows another asset's numbers.
6. **Non-BTC orders stay blocked** at the server until problems 1-4 are fixed and tested.

## 6. Proposed Phase 1 (once approved)

1. Deploy the BTC day recorder; capture the golden day.
2. Fix existing bug 6 and make fee/lot fallback fail visibly (problems 2, 8).
3. Build the Asset Registry from the products API, with `settlement_time`, lot, tick, fees and pagination.
4. Add the Quality Gate as pure functions with tests.
5. Add `asset` columns with a `'BTC'` default; update Pulse keys.
6. Route BTC through the registry and gate; replace `parseExpiry` and the lot constants.
7. Replay the golden day and confirm BTC metrics are unchanged.

## Appendix A: every BTC reference

Live backend and frontend, one line per match, cut to 170 characters. Excludes tests, the generated docs index and the one-off import script.

```text
backend/src/backtest/data/fetch-5y.ts:2: * Five years of BTCUSDT 15m candles (Binance) and hourly DVOL (Deribit), cached for the strangle search.
backend/src/backtest/data/fetch-5y.ts:6: * Output (gitignored): cache/btc-15m-5y.json  [tSec,o,h,l,c,v][]   cache/btc-dvol-1h-5y.json  [tSec,dvol][]
backend/src/backtest/data/fetch-5y.ts:20:      const r = await fetch(url, { headers: { 'User-Agent': 'btc-volatility-desk-backtest' }, signal: AbortSignal.timeout(30_000)
backend/src/backtest/data/fetch-5y.ts:35:    const k = (await getJson(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&startTime=${t}&endTime=${END}&lim
backend/src/backtest/data/fetch-5y.ts:48:    const j = await getJson(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${t}&en
backend/src/backtest/data/fetch-5y.ts:55:fs.writeFileSync(path.join(CACHE, 'btc-15m-5y.json'), JSON.stringify(c));
backend/src/backtest/data/fetch-5y.ts:58:fs.writeFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), JSON.stringify(d));
backend/src/backtest/data/fetch-binance.ts:2: * Fetch historical BTCUSDT OHLCV klines from Binance (public API) and cache to JSON.
backend/src/backtest/data/fetch-binance.ts:9: * Output: src/backtest/data/cache/btc-<interval>.json
backend/src/backtest/data/fetch-binance.ts:23:const SYMBOL = 'BTCUSDT';
backend/src/backtest/data/fetch-binance.ts:127:  const outPath = path.join(CACHE_DIR, `btc-${interval}.json`);
backend/src/backtest/data/fetch-delta-options.ts:6: * Phase 1: every expired BTC option product (symbol, strike, type, expiry), paged, resumable.
backend/src/backtest/data/fetch-delta-options.ts:29:      const r = await fetch(BASE + pathq, { headers: { 'User-Agent': 'btc-volatility-desk-backtest' }, signal: AbortSi
backend/src/backtest/data/fetch-delta-options.ts:48:    const p = await getJson('/v2/products?contract_types=call_options,put_options&underlying_asset_symbols=BTC&states=
backend/src/backtest/data/fetch-delta-options.ts:64:  const raw = JSON.parse(fs.readFileSync(path.resolve(here, 'cache/btc-15m-5y.json'), 'utf8')) as number[][];
backend/src/backtest/data/fetch-deribit-dvol.ts:2: * Fetch historical BTC DVOL (Deribit Volatility Index) and cache to JSON.
backend/src/backtest/data/fetch-deribit-dvol.ts:5: * Output: src/backtest/data/cache/btc-dvol-1h.json
backend/src/backtest/data/fetch-deribit-dvol.ts:27:  const url = `${BASE}?currency=BTC&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${RESOLUTION}`;
backend/src/backtest/data/fetch-deribit-dvol.ts:31:        headers: { 'User-Agent': 'BTC-Volatility-Desk-Backtest' },
backend/src/backtest/data/fetch-deribit-dvol.ts:54:  console.log(`[dvol] BTC DVOL ${new Date(START_MS).toISOString()} → ${new Date(END_MS).toISOString()} @ ${RESOLUTION
backend/src/backtest/data/fetch-deribit-dvol.ts:70:  const outPath = path.join(CACHE_DIR, 'btc-dvol-1h.json');
backend/src/backtest/data/inspect-archive.ts:38:const v5 = bundle?.indexedDB?.btc_iv_rv_terminal_v5?.stores || {};
backend/src/backtest/data/load.ts:27:  const p = path.join(CACHE, `btc-${interval}.json`);
backend/src/backtest/data/load.ts:46:    const dvolPath = path.join(CACHE, 'btc-dvol-1h.json');
backend/src/backtest/lib/simulate.ts:18:  contractBTC: number; // 100 lots x 0.001 BTC/lot = 0.1 BTC per leg
backend/src/backtest/lib/simulate.ts:63:  btcMovePct: number;
backend/src/backtest/lib/simulate.ts:73:    reachable12: false, maeUsd: 0, mfeUsd: 0, btcMovePct: 0, silence: false, maxMarkRatio: 0,
backend/src/backtest/lib/simulate.ts:111:  let btcHi = spot0, btcLo = spot0;
backend/src/backtest/lib/simulate.ts:118:    btcHi = Math.max(btcHi, b.h);
backend/src/backtest/lib/simulate.ts:119:    btcLo = Math.min(btcLo, b.l);
backend/src/backtest/lib/simulate.ts:169:  const btcMovePct = (Math.max(btcHi - spot0, spot0 - btcLo) / spot0) * 100;
backend/src/backtest/lib/simulate.ts:195:    btcMovePct,
backend/src/backtest/run.ts:48:      iv_conditions: ['IV>=35 filter did NOT reduce SLs (net-negative) — dropped.', 'Edge (IV-RV24) is structurally negative in BTC (~-7)
backend/src/backtest/run.ts:77:  const report = `# BTC Short-Strangle — Stop-Loss Elimination: Findings
backend/src/backtest/run.ts:97:- **IV ≥ 35 / IV > RV edge:** net-negative; BTC's Edge is structurally ~−7 (IV below RV).
backend/src/backtest/steps/backtest-timing.ts:45:  const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
backend/src/backtest/steps/calibrate.ts:5: *  (1) Validate the pricing/IV pipeline: my per-BTC credit ≈ shadow `cr` at the same
backend/src/backtest/steps/calibrate.ts:64:  console.log(`  my per-BTC credit vs shadow cr — median ratio: ${median(ratios).toFixed(3)}  mean: ${mean(ratios).toFixed(3)
backend/src/backtest/steps/friday.ts:61:  console.log('  date         entry   IV0   BTCmove%  leg   | late 23:00?  wider 3×?  band-adaptive?');
backend/src/backtest/steps/friday.ts:74:    stops.push({ day, entryT, iv0, move: sim.btcMovePct, leg: sim.hurtLeg, D0: f.D0,
backend/src/backtest/steps/friday.ts:81:  console.log(`  (Avg adverse BTC move on a Friday stop: ${f1(mean(stops.map((s) => s.move)))}% — confirms stops are price-run, 
backend/src/backtest/steps/night_paths.ts:2: * NIGHT PATHS — per-trade BTC price road, so entry + exit are visible ON the chart.
backend/src/backtest/steps/night_paths.ts:3: * For every TRADE night we export the 15m BTC closes from 18:00 (NY open) to 07:00 (exit),
backend/src/backtest/steps/night_paths.ts:85:  console.log('NIGHT PATHS — BTC road per trade (18:00→07:00, 15m), entry/exit/strikes marked:');
backend/src/backtest/steps/polish.ts:5: *   • VWAP-location veto — only sell when BTC sits near session VWAP (|σ|<1), not stretched
backend/src/backtest/steps/regime_gate_compare.ts:2: * Strangle Pulse Phase 3A, Task 2: compare candidate regime gates for the short strangle on five years of BTC data.
backend/src/backtest/steps/regime_gate_compare.ts:46:const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
backend/src/backtest/steps/regime_gate_compare.ts:49:const dv = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), 'utf8')) as number[][];
backend/src/backtest/steps/regime_gate_compare.ts:474:out('- **One path**: five years of one BTC history. Gates were defined beforehand, but TRAIN/VALID/HOLDOUT are still
backend/src/backtest/steps/strangle_final_5y.ts:35:const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
backend/src/backtest/steps/strangle_final_5y.ts:38:const dv = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), 'utf8')) as number[][];
backend/src/backtest/steps/strangle_search_5y.ts:7: *  - Underlying: Binance BTCUSDT 15m candles (Oct 2021 - Oct 2026). IV: Deribit DVOL (30-day index) times a
backend/src/backtest/steps/strangle_search_5y.ts:35:const raw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-15m-5y.json'), 'utf8')) as number[][];
backend/src/backtest/steps/strangle_search_5y.ts:38:const dvolRaw = JSON.parse(fs.readFileSync(path.join(CACHE, 'btc-dvol-1h-5y.json'), 'utf8')) as number[][];
backend/src/backtest/steps/strategy_rules.ts:20:  instrument: { product: 'BTC short strangle', expiry: 'N2N (3rd weekly)', delta: 0.15, legs: 'call + put' },
backend/src/backtest/steps/term_spread.ts:68:  console.log(`  avg spread ${f1(mean(rows.map((r) => r.spread)))} pts (BTC short-dated usually trades ${mean(rows.map((r) =>
backend/src/backtest/steps/weekday_patterns.ts:5: *   typical BTC move, and a one-line observed pattern.
backend/src/backtest/steps/weekday_patterns.ts:50:      if (iv0 != null && s.ok) byDow[f.dow].push({ iv0, stopped: s.stopped, win: s.pnlPctMargin > 0, leg: (s.hurtLeg || 
backend/src/backtest/steps/year_calendar.ts:108:      why = `${leg === 'put' ? 'Put' : 'Call'} leg hit ${stopOf(n.iv0)}× — BTC ran ${sim.btcMovePct >= 0 ? '+' : ''}${s
backend/src/backtest/steps/year_calendar.ts:119:      out, pnl: +sim.pnlPctMargin.toFixed(1), move: +sim.btcMovePct.toFixed(1), why, ...(fix ? { fix } : {}),
backend/src/db/schema.ts:69:  underlying: varchar('underlying', { length: 20 }).default('BTC').notNull(),
backend/src/db/schema.ts:147: * Replaces `localStorage['btc_drawings_v1']`.
backend/src/db/schema.ts:155:  symbol: varchar('symbol', { length: 20 }).default('BTCUSDT').notNull(),
backend/src/db/schema.ts:167: * Replaces `v132_ind`, `v143_skin`, `pa_layer_prefs_v3`, and `btc_vol_desk_prefs_v1`.
backend/src/db/schema.ts:207: * Replaces `localStorage['btc_alerts_v1']`.
backend/src/db/schema.ts:283: * - fund: Delta BTCUSD perpetual funding rate
backend/src/db/schema.ts:292:    symbol: varchar('symbol', { length: 20 }).default('BTCUSDT').notNull(),
backend/src/db/schema.ts:325:    symbol: varchar('symbol', { length: 20 }).default('BTC').notNull(),
backend/src/lib/algo/event-path.ts:4: * "Is a news event in the path of this trade?" A live short strangle is skipped when a US release that moves BTC volatility (the des
backend/src/lib/algo/market-report.ts:239:  const summary = `BTC is ${trendWord} at ${spot.toFixed(0)} (direction score ${sg(score, 0)}). ${calm} indicators are calm for 
backend/src/lib/algo/plan.ts:104:  // premium collected by the sold legs, at the bid, in USD (one lot = 0.001 BTC)
backend/src/lib/algo/profit.ts:3: * Pure arithmetic over numbers the Delta chain already gives (theta per day, gamma, IV); no forecast of BTC or IV.
backend/src/lib/algo/profit.ts:18:/** One lot is 0.001 BTC and Delta quotes option prices and theta per 1 BTC. */
backend/src/lib/algo/profit.ts:22:/** What the position earns each day from time decay if BTC and IV stay where they are (negative when you are long and paying it). */
backend/src/lib/algo/profit.ts:43: * What time alone earns between now and the exit: each leg re-priced at the exit with BTC and IV unchanged (Black-Scholes),
backend/src/lib/algo/profit.ts:67:    note: 'Time decay only, before fees, if BTC and IV stay where they are, and never more than the premium collected. A big move can wi
backend/src/lib/ask/glossary-more.ts:29:    'The Paper page is your own Delta-style practice account, separate from the bot. You start with fake cash (default $10,000), s
backend/src/lib/ask/glossary-more.ts:39:    'Buying an option pays its premium out of cash and the position is then worth its current mark; selling an option receives the
backend/src/lib/ask/glossary-more.ts:47:    'A call gains when BTC rises above its strike; a put gains when BTC falls below its strike. Buying either risks only the premi
backend/src/lib/ask/glossary-more.ts:49:    'The strike is the price an option is struck at. A call is in the money (ITM) when BTC is above its strike, out of the money (
backend/src/lib/ask/glossary-more.ts:51:    'Delta says how much an option moves per $1 move in BTC. Gamma says how fast delta itself changes (high near expiry and at the
backend/src/lib/ask/glossary-more.ts:56:  g('perp', 'Perpetual futures (BTCUSD)', ['perpetual', 'perp', 'btcusd', 'futures', 'perpetual future', 'funding rate', 'contract
backend/src/lib/ask/glossary-more.ts:57:    'The BTC perpetual has no expiry. It stays close to the spot price through a funding payment between longs and shorts. On Delt
backend/src/lib/ask/glossary-more.ts:59:    'A short strangle makes its maximum profit, the combined premium, if BTC finishes between the two strikes. It breaks even at t
backend/src/lib/ask/glossary.ts:13:    'Delta lists a new BTC option expiry every day, settling at 17:30 IST (12:00 UTC). On the desk "Cur" is the current expiry, "Next" 
backend/src/lib/ask/glossary.ts:15:    'Delta India BTC options settle at 17:30 IST every day (12:00 UTC). The "Delta exp" countdown in the header is the time left to the
backend/src/lib/ask/glossary.ts:23:    'Realised volatility is how much BTC has actually moved, annualised, measured from the index candles. "RV FAST" weights every minut
backend/src/lib/ask/glossary.ts:27:    'DVOL is Deribit\'s 30-day implied-volatility index for BTC. The header shows it with its percentile over the stored history (for e
backend/src/lib/ask/glossary.ts:31:    'Edge is ATM IV minus recent realised volatility, in vol points. Positive means options are priced richer than the market has been 
backend/src/lib/ask/glossary.ts:39:    'The funding rate is the periodic payment between longs and shorts on the BTC perpetual that keeps it close to spot. High positive 
backend/src/lib/ask/glossary.ts:45:    'ADX measures how strongly BTC is trending (not which direction). A rising ADX means a trend is building, which hurts a short stran
backend/src/lib/ask/glossary.ts:65:    'A short strangle sells an out-of-the-money call and an out-of-the-money put on the same expiry. You keep the premium if BTC stays 
backend/src/lib/ask/glossary.ts:75:    'One Delta BTC contract (lot) is 0.001 BTC. 100 lots per leg is therefore 0.1 BTC per leg. Option prices are quoted in USD per 1 BT
backend/src/lib/ask/glossary.ts:97:    'The economy state is the desk\'s own read of the market regime, computed from its live indicators: speed vs IV, ATM IV, 6-hour and
backend/src/lib/ask/glossary.ts:117:    'The expected-move band is the range BTC is expected to stay inside to the planned expiry at plus or minus one standard deviation 
backend/src/lib/ask/parse.ts:276:  if (has(q, /\b(market|spot|price|btc|dvol|iv|volatility|funding|open interest|oi|macro|stress|vix|gate|go or wait)\b/)) return out('mar
backend/src/lib/bot/calendar.ts:35: * Value at the FRONT expiry, as a function of spot, of the whole position per 1 BTC of each leg:
backend/src/lib/bot/calendar.ts:48:  /** Modelled PnL per BTC at the strike at front expiry (the profit peak). */
backend/src/lib/bot/calendar.ts:53: * Spot levels at front expiry where the calendar breaks even, given the net debit per BTC paid at
backend/src/lib/bot/futures.ts:6: * Directional BTC perpetual strategies (pure; shared by replay and the live paper engine):
backend/src/lib/bot/paper-terminal.ts:11: *  - the BTC perpetual only moves cash through realised PnL and fees (linear USD approximation);
backend/src/lib/bot/paper-terminal.ts:265:  /** Price paid (buy) or received (sell), USD per 1 BTC. */
backend/src/lib/bot/portfolio-margin.ts:4: * Approximation of Delta Exchange India's Portfolio Margin for BTC options (published method):
backend/src/lib/bot/portfolio-margin.ts:49: * 90.3x effective leverage Delta shows for a BTC future in portfolio margin (1 / 90.3 = 1.107% of position value).
backend/src/lib/bot/portfolio-margin.ts:68:/** OM% for the margin floor: 0.5% base to $200K options notional, tiny slope, capped at 2% (BTC). */
backend/src/lib/bot/replay.ts:267:    // The breakeven is per BTC and for both legs; a profit zone must exist or there is nothing to trade.
backend/src/lib/bot/rules.ts:4: * Mark-to-market PnL for a multi-leg position. Option prices are USD per 1 BTC underlying;
backend/src/lib/bot/rules.ts:5: * a lot is `contractValue` BTC (0.001), so per-leg PnL is price move x lots x contractValue.
backend/src/lib/bot/sizing.ts:7:  /** Underlying per lot (0.001 BTC), so one lot gains/loses contractValue USD per 1 USD move. */
backend/src/lib/bot/strike-picker.ts:15:  /** Greeks from the live chain (absent in replayed chains). Theta is per day, per 1 BTC. */
backend/src/lib/bot/types.ts:28:  /** Lots (Delta contract_value, 0.001 BTC per lot, converts to underlying size). */
backend/src/lib/bot/types.ts:30:  /** Average fill price (USD premium per 1 BTC underlying). */
backend/src/lib/bot/types.ts:64:  /** Contract value in underlying units per lot (0.001 BTC). */
backend/src/lib/macro.ts:2: * Pure maths for the Macro Stress lane: quote freshness, market moves, correlation with BTC, news-event weighting and
backend/src/lib/macro.ts:67:/** Correlation of a market's hourly returns with BTC's over the hours both traded, and how many hours that was. */
backend/src/lib/macro.ts:68:export function correlationWithBtc(market: ReadonlyMap<number, number>, btc: ReadonlyMap<number, number>): { corr: number | null; hours: numbe
backend/src/lib/macro.ts:71:  for (const [h, r] of market) { const b = btc.get(h); if (b != null) { xs.push(r); ys.push(b); } }
backend/src/lib/macro.ts:76: * How tied a market group is to BTC, 0 to 1. The strength of the relationship matters, not its sign (the VIX moves
backend/src/lib/macro.ts:77: * against BTC and still transmits stress), so it uses |correlation|. With little data it falls back to the prior,
backend/src/lib/macro.ts:108: * The calendar feed lists every currency's releases. Only US releases move BTC volatility on the desk's rule
backend/src/lib/option-flow.ts:2: * Option flow: what traders actually did in BTC options (Deribit prints), summarised by strike and by window.
backend/src/lib/option-flow.ts:8:  /** Size in BTC. */
backend/src/lib/option-flow.ts:10:  /** Premium per BTC, quoted in BTC. */
backend/src/lib/option-flow.ts:24:/** BTC-28OCT26-80000-C -> { call, 80000, 28OCT26 } */
backend/src/lib/option-flow.ts:26:  const m = /^BTC-([0-9]{1,2}[A-Z]{3}[0-9]{2})-([0-9]+)-([CP])$/.exec(name);
backend/src/lib/option-flow.ts:32:  /** BTC bought and sold (the aggressor's side, as Deribit reports it). */
backend/src/lib/option-flow.ts:115:  if (s.blockVol > 0) parts.push(`${s.blockVol.toFixed(0)} BTC in blocks`);
backend/src/lib/pulse/config.ts:20:  futuresSymbol: 'BTCUSD',
backend/src/lib/pulse/config.ts:23:  /** BTC per futures contract. */
backend/src/lib/pulse/metrics/series.ts:65:  /** BTC perp spot at this step. */
backend/src/lib/pulse/metrics/series.ts:67:  /** Signed BTC move since entry in percent, divided by the square root of hours held (a random walk scales with that), floore
backend/src/routes/alerts.ts:171:    const topic = body.topic || process.env.NTFY_DEFAULT_TOPIC || 'btc-volatility-desk';
backend/src/routes/alerts.ts:174:      title: '🚨 BTC Volatility Desk Test Alert',
backend/src/routes/cal.ts:24:      const res = await fetch(FF[week], { headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.timeout(12_000) }
backend/src/routes/delta.ts:44:      headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0'
backend/src/routes/delta.ts:66:      headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent
backend/src/routes/delta.ts:86:      headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent
backend/src/routes/delta.ts:162:        headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
backend/src/routes/drawings.ts:22:    const { symbol = 'BTCUSDT' } = request.query as { symbol?: string };
backend/src/routes/drawings.ts:43:      symbol: body.symbol || 'BTCUSDT',
backend/src/routes/market.ts:19:      symbol = 'BTCUSDT',
backend/src/routes/market.ts:58:      symbol = 'BTC',
backend/src/routes/market.ts:90:      symbol = 'BTCUSDT',
backend/src/routes/migration.ts:7: * (spec in MIGRATION.md: `v99_trades`, `v147_nights`, `btc_drawings_v1`, etc.) is
backend/src/routes/mkt.ts:34:/** Only the one file family the desk needs, with a real date: https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metr
backend/src/routes/mkt.ts:35:const ARCHIVE_RE = /^\/data\/futures\/um\/daily\/metrics\/BTCUSDT\/BTCUSDT-metrics-(\d{4})-(\d{2})-(\d{2})\.zip$/;
backend/src/routes/mkt.ts:61:          const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.ti
backend/src/routes/mkt.ts:124:          headers: { Accept: 'application/json', 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
backend/src/routes/score.ts:31:  const opt = legs.filter((l) => /^[CP]-BTC-/.test(l.symbol));
backend/src/routes/score.ts:32:  const perp = legs.filter((l) => !/^[CP]-BTC-/.test(l.symbol));
backend/src/routes/score.ts:34:  if (!opt.length && perp.length === 1) return mk(perp[0]!.side === 'buy' ? 'BTC futures long' : 'BTC futures short');
backend/src/routes/trades.ts:117:      underlying: body.underlying || 'BTC',
backend/src/scripts/port_original_html.js:53:          localStorage.setItem('btc_drawings_v1', JSON.stringify(drawData.data));
backend/src/scripts/port_original_html.js:83:// Note: __dirname is backend/src/scripts, so ../../../ is BTC Volatility Desk, then frontend/index.html
backend/src/services/alert-service.ts:74:      const ntfyTopic = process.env.NTFY_DEFAULT_TOPIC || 'btc-volatility-desk';
backend/src/services/alert-service.ts:108:                  android_channel_id: `btc_alerts_${dev.soundChoice || 'chime'}`,
backend/src/services/alert-service.ts:169:            alertMessage = `BTC spot crossed $${threshold.toLocaleString()}. Current: $${metrics.spotPrice.toLocaleString()}`;
backend/src/services/algo/algo-engine.ts:241:      // dollars of profit or loss on the position: one lot is 0.001 BTC
backend/src/services/algo/algo-engine.ts:257:  return plan.kind === 'option' ? plan.legs.map(describeLeg) : [`${plan.future.side === 'long' ? 'Buy' : 'Sell'} ${plan.futur
backend/src/services/algo/algo-runtime.ts:27:    bars = { at: now, v: await fetchCandles('BTCUSD', '5m', Math.floor(now / 1000) - 6 * 86_400, Math.floor(now / 1000)) };
backend/src/services/algo/algo-service.ts:164:        : [{ symbol: 'BTCUSD', side: plan.future.side === 'long' ? 'buy' as const : 'sell' as const, lots: plan.future.lots 
backend/src/services/algo/brokers.ts:9:const PERP = 'BTCUSD';
backend/src/services/algo/brokers.ts:12:/** The price at which a futures stop of `futStopUsd` dollars (or, for older rules, a percent) is hit. One lot is 0.001 BTC, so $1
backend/src/services/algo/brokers.ts:29:      return r.ok ? { ok: true, ref: (r as { basketId: string }).basketId, detail: `${side} ${lots} lots BTC perpetual` } : { ok: 
backend/src/services/algo/brokers.ts:48:    const fut = leg && /^BTCUSD$/.test(leg.symbol) && leg.mark != null ? { entry: leg.entry, mark: leg.mark, side: leg.side === 'b
backend/src/services/algo/event-guard.ts:25:        const res = await fetcher(url, { headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' }, signal: AbortSignal.tim
backend/src/services/algo/insights-service.ts:9: *  1. Market insights: which indicators worked on the last four weeks of 15 minute BTC candles (recomputed every few hour
backend/src/services/algo/insights-service.ts:18:const realFetch: Fetcher = (a, b) => fetchCandles('BTCUSD', '15m', a, b);
backend/src/services/algo/live-entry.ts:263:/** "exit" in Ask me for real positions: close every BTC option position, expiry by expiry, through the hard-exit path and its
backend/src/services/algo/live-entry.ts:286: * Cancel the user's pending BTC option orders on Delta. 'resting' = the limit orders sitting in the book (anything that could
backend/src/services/algo/live-entry.ts:315:    return { sent: cancelled > 0, cancelled: cancelling ? cancelled : undefined, message: cancelling ? `There are no open BTC 
backend/src/services/algo/series.ts:79:  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=
backend/src/services/algo/series.ts:80:  const r = await fetch(url, { headers: { 'User-Agent': 'BTC-Volatility-Desk' }, signal: AbortSignal.timeout(15_000) });
backend/src/services/ask/answer.ts:76:  FUT_SWEEP_LDN: 'BTC perpetual. When London sweeps the Asia high or low (a wick beyond it that closes back inside) and at least 2 o
backend/src/services/ask/answer.ts:78:  FUT_SIGNAL: 'BTC perpetual, any time. Needs 2 agreeing price votes (reclaim of the prior day\'s high/low, a volume breakout beyond
backend/src/services/ask/answer.ts:195:  lines.push(`Entered ${when(r.entry_at)}: ${legs.map((l) => `${l.side} ${l.lots} ${l.type === 'future' ? 'lots BTCUSD' : `${l.type
backend/src/services/ask/answer.ts:342:  lines.push(`BTC spot ${m.spot == null ? 'n/a' : Math.round(m.spot)}${m.mark != null ? `, perpetual mark ${Math.round(m.mark)}` : 
backend/src/services/ask/answer.ts:454:    'glossary:funding': m.funding == null ? null : `Right now the BTC perpetual funding rate is ${(m.funding * 100).toFixed(4)}%.`,
backend/src/services/ask/answer.ts:566:    ...pos.map((r) => ['position', r.symbol, `${Number(r.lots) > 0 ? '+' : ''}${r.lots} lots`, `entry ${r.avg_entry}`, r.symbol ===
backend/src/services/ask/answer.ts:653:      // the plain price of BTC is a live number, not a glossary term
backend/src/services/ask/answer.ts:654:      if (/\b(price|spot)\b/i.test(question) && /\b(btc|bitcoin)\b/i.test(question) && !/\b(mark|bid|ask|slippage|fill|strike|premi
backend/src/services/ask/answer.ts:658:      if (/\b(price|spot|btc|funding|dvol|open interest)\b/i.test(question)) return safe(base, () => market(p, c));
backend/src/services/binance-market-worker.ts:109:                  symbol: 'BTCUSDT',
backend/src/services/bot/delta-public.ts:43: * Delta option symbols look like `C-BTC-99000-271126`: type, underlying, strike, DDMMYY.
backend/src/services/bot/delta-public.ts:93:    headers: { 'User-Agent': 'btc-volatility-desk-bot', Accept: 'application/json' },
backend/src/services/bot/delta-public.ts:105:    getJson<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=call_options&underlying_asset_symbols=BTC'),
backend/src/services/bot/delta-public.ts:106:    getJson<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=put_options&underlying_asset_symbols=BTC'),
backend/src/services/bot/delta-public.ts:163:    }>('/v2/products?contract_types=call_options,put_options&underlying_asset_symbols=BTC&states=live&page_size=500', 20_000)
backend/src/services/bot/delta-public.ts:200:export const DEFAULT_PERP: PerpInfo = { symbol: 'BTCUSD', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, maxLeve
backend/src/services/bot/delta-public.ts:202:/** Contract size and fee rates for the BTC perpetual, from the products API. */
backend/src/services/bot/delta-public.ts:203:export async function fetchPerpInfo(symbol = 'BTCUSD'): Promise<PerpInfo> {
backend/src/services/bot/delta-public.ts:232:export async function fetchPerpQuote(symbol = 'BTCUSD'): Promise<PerpQuote> {
backend/src/services/bot/futures-live.ts:103:      this.bars = await fetchCandles('BTCUSD', '1m', endSec - BUFFER_BARS * 60, endSec);
backend/src/services/bot/futures-live.ts:105:      const fresh = await fetchCandles('BTCUSD', '1m', endSec - 15 * 60, endSec);
backend/src/services/bot/futures-live.ts:205:    const book = await fetchBook('BTCUSD', 40);
backend/src/services/bot/futures-live.ts:234:    await insertLeg(runId, { symbol: 'BTCUSD', type: 'future', side: p.dir, role: 'body', strike: 0, expiryMs: 0, lots: p.lot
backend/src/services/bot/futures-live.ts:235:    await insertFill(runId, { legSymbol: 'BTCUSD', action: 'entry', side: p.dir === 'long' ? 'buy' : 'sell', lots: p.lots, in
backend/src/services/bot/futures-live.ts:254:    await setLegExit(run.id, 'BTCUSD', price);
backend/src/services/bot/futures-live.ts:255:    await insertFill(run.id, { legSymbol: 'BTCUSD', action: 'exit', side: run.st.dir === 'long' ? 'sell' : 'buy', lots: run.s
backend/src/services/bot/futures-live.ts:296:        legs: [{ symbol: 'BTCUSD', type: 'future', side: run.st.dir, role: 'body', lots: run.st.lots, entryPrice: run.st.entr
backend/src/services/delta-feed.ts:60:        'User-Agent': 'BTC-Volatility-Desk/1.0',
backend/src/services/delta-market-worker.ts:71:        // Subscribe to BTCUSD and options ticker channel
backend/src/services/delta-market-worker.ts:78:                symbols: ['BTCUSD', 'BTCUSDT'],
backend/src/services/delta-market-worker.ts:152:          symbol: 'BTCUSDT',
backend/src/services/deribit-flow-worker.ts:48:   * Fetches latest BTC DVOL (Implied Volatility Index) from Deribit
backend/src/services/deribit-flow-worker.ts:54:      const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&en
backend/src/services/deribit-flow-worker.ts:57:        headers: { 'User-Agent': 'BTC-Volatility-Desk' },
backend/src/services/deribit-flow-worker.ts:87:      const url = 'https://www.deribit.com/api/v2/public/get_last_trades_by_currency?currency=BTC&kind=option&count=50';
backend/src/services/deribit-flow-worker.ts:89:        headers: { 'User-Agent': 'BTC-Volatility-Desk' },
backend/src/services/deribit-flow-worker.ts:111:        const isBlock = tr.block_trade_id != null || amount >= 10; // 10+ BTC option size
backend/src/services/deribit-flow-worker.ts:127:            symbol: 'BTC',
backend/src/services/greek-pnl.ts:15:  contract_value?: number; // usually 0.001 BTC per contract on Delta
backend/src/services/macro-stress-worker.ts:4: * Sits as a lane under the BTC chart and shares its time axis.
backend/src/services/macro-stress-worker.ts:15: * 2. Link per group = |correlation| of hourly returns with BTC over the last 5 days, blended half and half with a
backend/src/services/macro-stress-worker.ts:20: * 6. Direction (risk-off / risk-on) and the expected BTC RV uplift.
backend/src/services/macro-stress-worker.ts:129:const BTC_SYMBOL = 'BTC-USD';
backend/src/services/macro-stress-worker.ts:245:      const jobs = [...Object.values(SYMBOLS), BTC_SYMBOL].map(async (sym) => {
backend/src/services/macro-stress-worker.ts:249:          if (sym !== BTC_SYMBOL) this.quotes.set(sym, quote);
backend/src/services/macro-stress-worker.ts:253:          if (sym !== BTC_SYMBOL) this.failedNow.add(sym);
backend/src/services/macro-stress-worker.ts:323:        headers: { 'User-Agent': 'BTC-Volatility-Desk-Backend/1.0' },
backend/src/services/macro-stress-worker.ts:359:    const btc = this.series.get(BTC_SYMBOL);
backend/src/services/macro-stress-worker.ts:360:    if (!btc || btc.length < 100) return prior;
backend/src/services/macro-stress-worker.ts:361:    const btcRet = hourlyReturns(btc);
backend/src/services/macro-stress-worker.ts:364:      return pts && pts.length ? correlationWithBtc(hourlyReturns(pts), btcRet).corr : null;
backend/src/services/paper/flow.ts:36:           FROM option_flow_buckets WHERE symbol = 'BTC' AND time >= now() - ($1 || ' hours')::interval`,
backend/src/services/paper/flow.ts:56:    const res = await fetch('https://www.deribit.com/api/v2/public/get_last_trades_by_currency?currency=BTC&kind=option&count=1000&i
backend/src/services/paper/flow.ts:57:      headers: { 'User-Agent': 'BTC-Volatility-Desk' },
backend/src/services/paper/market.ts:5: * Live market data for the Paper Trade terminal: the BTC option board (bid, ask, sizes, IV, greeks, open
backend/src/services/paper/market.ts:117:      deltaGet<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=call_options&underlying_asset_symbols=BTC'),
backend/src/services/paper/market.ts:118:      deltaGet<{ result?: DeltaTicker[] }>('/v2/tickers?contract_types=put_options&underlying_asset_symbols=BTC'),
backend/src/services/paper/market.ts:119:      deltaGet<{ result?: Record<string, any> }>('/v2/tickers/BTCUSD'),
backend/src/services/paper/market.ts:125:    if (!spot) throw new Error('Delta returned no BTC price');
backend/src/services/paper/paper-terminal.ts:201:/** Option symbols look like C-BTC-82000-301026; used to settle a position after its contract has left the board. */
backend/src/services/paper/paper-terminal.ts:613:  /** Net exposure of the whole account: delta in BTC (the perpetual counts one for one), and the option greeks scaled to
backend/src/services/pulse/hourly-bars.ts:11:const KLINES_URL = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h';
backend/src/services/pulse/hourly-bars.ts:59: * In-memory hourly BTC bars from Binance public klines, for the read-only regime gate.
backend/src/services/watch/live-exit.ts:13: *    sold); it can never open or enlarge a position, and it never touches anything but BTC options;
backend/src/services/watch/live-exit.ts:21:export const OPTION_SYMBOL = /^[CP]-BTC-\d+-\d{6}$/;
frontend/index.html:3:  v147 (18 Oct 2026, preview, not deployed): Trade clock on the BTC chart + Trade calendar + hourly overview
frontend/index.html:13:  v146.2 (17 Oct 2026, preview, not deployed): panes drifted on phones because they follow the BTC chart by slot number and
frontend/index.html:14:    the BTC chart carried extra time slots (drawings, overlays, live points, grown history); every pane under #paneG now
frontend/index.html:15:    mirrors the BTC chart's time slots (invisible whitespace series), checked with injected slots: 861 px → ≤2 px.
frontend/index.html:17:  v146 (17 Oct 2026, preview, not deployed): new FUTURES section (Indicators menu, on by default) — Binance BTCUSDT perp
frontend/index.html:22:    an old range), Entry · Hold · Exit strip gets its (blank) axis column, lower panes repaint on each new BTC candle. Module: W.v146f (last scri
frontend/index.html:24:    for every 15 min, SELL / EXIT pills + hold band on the BTC chart, alert center with full-screen alerts (replaces the
frontend/index.html:30:    Blink: the charts had a 0.45 s fade-in (chartIn); Chrome restarted it every few seconds on the live BTC chart, so the
frontend/index.html:38:    Free space: the BTC chart box grows into any free height at once (flex 1 0 auto) when indicators are removed.
frontend/index.html:42:    flat near-black panel, 1-px section lines, plain-text legends, hover-only zoom/grip, flat toolbar, no 'BTC · Full screen' row.
frontend/index.html:86:  v131 (16 Oct 2026, preview, not deployed): VOL CHARTS picker (IV · RV · VoV · DVOL, several at once) sits right under the INDICATOR tabs in th
frontend/index.html:87:  v130 (16 Oct 2026, preview, not deployed): one full screen — both buttons show the BTC chart platform only; side panels, Tonight rail, notices,
frontend/index.html:89:  v127 (16 Oct 2026, preview, not deployed): Option A — one indicator under the BTC chart via tabs (Speed vs IV · Edge · Range · ADX), vol-cha
frontend/index.html:93:  v123 (16 Oct 2026, preview, not deployed): clean charts — sessions only on BTC/Range (IV keeps lines), Speed strip only under IV, VoV/RV/DVOL a
frontend/index.html:106:  v116 (15 Oct 2026, preview, not deployed): Edge / Range stay on the BTC chart's time window (alignment guard compares the
frontend/index.html:107:    visible time windows every second and snaps a drifted pane back; it could sit days off after the BTC bar list changed);
frontend/index.html:128:  v111 (15 Oct 2026, preview, not deployed): chart order set by Abhishek — 1 Tonight graph, 2 BTC chart, 3 Speed vs IV,
frontend/index.html:132:    1. BTC chart no longer jumps on opening: the saved range (1D…) is set in the same paint as the first candles (and at once
frontend/index.html:134:    2. Trade page order, phone and desktop: vol stack (IV · VoV · RV · DVOL) first → BTC chart (desktop: Leading signals +
frontend/index.html:149:    4. ADX removed from the IV and RV charts (module voladx is now a layout shim; BTC-chart ADX unchanged).
frontend/index.html:155:       the desk first saw the trade) are rebuilt from Delta's 15-minute mark candles + BTC index, IV implied from each mark,
frontend/index.html:174:    (cents under $10), strangle stop, each leg (lots, sold, now, IV sold → now, delta, P&L, 2× leg stop and the BTC level that
frontend/index.html:176:    theta covers vs BTC's measured 6 h move), live payoff (now and at expiry, stop zones, breakevens). P&L split adds
frontend/index.html:186:  v105.24 (14 Oct 2026): BTC chart no longer opens with the candles squeezed into the left third — range buttons
frontend/index.html:191:  v105.23 (14 Oct 2026): chart is the core on desktop — BTC candle pane 208 → 358 px at 1440×900 (350 → 506 at 1920×1080):
frontend/index.html:195:    (1360 px+) puts the BTC chart with Speed vs IV / Edge / Range / ADX on the left at full height and a scrolling side column
frontend/index.html:201:    #rkSec; their phrases dropped from the Flow status line). 24×7 clock: new views Speed vs IV and Edge (from stored 5-min BTC
frontend/index.html:246:  · BTC chart: duplicate left-edge γ flip / call wall / put wall names hidden (price-scale names and lines stay).
frontend/index.html:266:  Order-flow chart pane (#ofPane) removed. VPI pane hidden (#paVolBox) and replaced by two candle panes under the BTC chart
frontend/index.html:268:  realised to the planned exit (v101 model, W.v101.edgeSeries), lines +3 sell / 0; RANGE = largest BTC move from 24 h ago ÷
frontend/index.html:273:  script[data-module=v103] and #sdTradeHost gone). Chart sync fixes: Edge / Range panes carry exactly the BTC series' items
frontend/index.html:274:  (logical indices always match) and follow the BTC chart one way unless touched; the hidden VPI chart and the ADX pane no
frontend/index.html:275:  longer push ranges into the BTC chart (a 0-width hidden chart was moving it). Edge skips a fresh listing's first 3 h
frontend/index.html:300:  Highest put / call OI of the master expiry as BTC price lines. Term tab (ATM IV by expiry now / 1 h / 1 day; v100_term) replaces 4D vol
frontend/index.html:303:  when ADX falls from its peak; RV ADX on bodies. Desk session IV change = the master expiry's IV. Desktop BTC block = one screen.
frontend/index.html:311:  (localStorage v99_trade {exp,Kp,Kc,lot,fills[{t,lots,cr}],openedAt,exitAt}; credit = put + call premium per BTC), live legs from getChain
frontend/index.html:324:  v95 (11 Oct 2026, preview): Desk BTC chart: session boxes (1m–1h) coloured by session IV level (1-day IV / DVOL vs 365 days) with
frontend/index.html:328:  v94 (11 Oct 2026, preview): script[data-module=v94-layers] (window.RegLayers): Regime BTC candles drawn as layers in the overlay
frontend/index.html:352:  BTC movement (Parkinson variance of 5-min index bars by SessCal session, quiet post-NY tail left out), last 10 weekdays vs
frontend/index.html:360:  v89 (11 Oct 2026, preview): NY-first Desk. Header NY-phase pill; ticker of 8 (BTC · Next IV + bid · N2N IV · DVOL · RV fast ·
frontend/index.html:366:  heat map / vol turn / events; IV · RV fast · VoV fast · DVOL mini charts with 1-h lines; BTC chart: 30-m NY opening range
frontend/index.html:375:  shown as the real hit rate of past cases like it ± 95 % range); ADX/ATR legend adds the measured chance BTC moves more than
frontend/index.html:388:  exits) · Speed vs IV drawn as towers: lane under the BTC chart (one tower per chart bar at 15 m+, per 15-m block below;
frontend/index.html:393:  v84 (9 Oct 2026): review fixes + presentation layer (<style id="v84Css">) · BTC chart keeps today in view when deeper
frontend/index.html:399:  v84 Speed vs IV (10 Oct 2026, measured only): BTC realised (1-m Parkinson) ÷ ATM IV of the chosen expiry (Cur / Next / N2N switch, default N2N;
frontend/index.html:401:  WEEKDAY runs (weekends left out); card on top of the Strangle Signal + lane under the BTC chart. No entry rules or alerts.
frontend/index.html:404:  v83 (9 Oct 2026): Regime page — Week / Month / Year on daily / weekly / monthly candles of BTC, 1-day IV, RV, VoV,
frontend/index.html:406:  strip · every chart group shares one price-scale width and one crosshair with a time label · BTC candle size under
frontend/index.html:411:  · 24×7 heat map for RV / IV / VoV / DVOL · window-effect RV candles hollow instead of grey · ticker, BTC chips, event
frontend/index.html:572:      function prio(u) { u = typeof u === 'string' ? u : (u && u.url) || ''; if (u.indexOf('MARK%3A') > 0 || u.indexOf('MARK:') > 0) return 0; if 
frontend/index.html:614:  <script>/* v152: one time, the desk opens as the BTC chart only; the auto layout that switched everything on when a trade opened is off (it stay
frontend/index.html:3285:    /* v144: was a 0.45 s fade-in (chartIn); Chrome restarted it every few seconds on the live BTC chart = the blink */
frontend/index.html:16019:    /* ---------- BTC chart platform ---------- */
frontend/index.html:16967:      /* BTC chart: one indicator pane at a time, picked by tabs */
frontend/index.html:17138:      /* BTC toolbar on the phone: row 1 symbol · timeframes · panes, row 2 the tools (alerts, replay, go to, draw) */
frontend/index.html:17408:    /* chip rows over the BTC and IV charts: one line that scrolls sideways, never spilling under the chart
frontend/index.html:17754:    /* ticker, BTC chips and panel heads are tappable */
frontend/index.html:18228:    /* ---- crosshair time pill + BTC candle size ---- */
frontend/index.html:18287:    /* ---- Phone: the BTC tabs are never clipped under the indicator pane ---- */
frontend/index.html:18346:    /* BTC overlays */
frontend/index.html:18707:    /* BTC pane title wrapped onto three lines and covered the chip row */
frontend/index.html:19401:   The BTC chart, Order flow, VPI and ADX need ~760 px; the platform was fixed at 72vh (684 px on a 950-px window), so ADX
frontend/index.html:19578:    /* speed lane under the BTC chart */
frontend/index.html:20044:        <div class="vtg-title">BTC Volatility Desk</div>
frontend/index.html:20525:    /* v133: first open after this update → BTC chart layers off (session shading/boxes, candle and chart patterns, structure,
frontend/index.html:20546:        <div class="t" id="tkSpot"><b>BTC</b><span class="v num">—</span><span class="d num muted">—</span></div>
frontend/index.html:20824:          <!-- BTC chart platform -->
frontend/index.html:20827:              <span class="sym">BTC <small>· Delta index</small></span>
frontend/index.html:20846:                <div class="pane-head"><span class="pane-title"><i class="pt-dot"></i>BTC <em>· Delta index · dealer
frontend/index.html:20900:                    <dt>BTC spot</dt>
frontend/index.html:21022:                      title="Fast RV and VoV: every minute weighted by age, 45-minute half-life, so they fall with IV once BTC calms instead of 
frontend/index.html:21124:2 BTC chart → Speed vs IV → Edge · Range · ADX (desktop: Leading signals in the side column)
frontend/index.html:21161:              <div class="edge-sec-h">Deribit options flow<small id="dfSub">BTC · every 15 min, live</small></div>
frontend/index.html:21174:                  <p><b>Source.</b> Every BTC option trade Deribit publishes, read every 10 seconds. These are the
frontend/index.html:21362:                  √hours) with the move the realized-vol forecast expects over the same hours, using how much of BTC's
frontend/index.html:21373:                  mid-hold with IV rising as BTC moves, is worth your stop multiple of the entry premium, and estimates
frontend/index.html:21461:              <p><b>v105.</b> Edge and Range candles under the BTC chart replace the VPI and order-flow panes; the
frontend/index.html:21468:              <p><b>v80.</b> 24×7 short-strangle terminal for BTC options on Delta Exchange India. Data: Delta
frontend/index.html:21729:        if (HOLD.io && el && el.id !== 'chartG') { HOLD.els.set(el, entry); HOLD.io.observe(el); }   // v105.14: phones draw a chart only while 
frontend/index.html:21775:       BTC ATM IV engine (v32)
frontend/index.html:21787:    const STORE_KEY = 'btc_atm_iv_delta_india_v30';           // same key: existing data keeps working
frontend/index.html:21788:    const LEGACY_STORE_KEYS = ['btc_atm_iv_delta_india_v29', 'btc_atm_iv_delta_india_v28', 'btc_atm_iv_delta_india_v27', 'btc_atm_iv_delta_india
frontend/index.html:21789:    const IDB_NAME = 'btc_atm_iv_persistent_v30';
frontend/index.html:21792:    const THEME_KEY = 'btc_atm_iv_theme_v132';   // v122: new key so the desk opens light once; your switch is remembered here
frontend/index.html:21795:    const EXPIRY_UTC_HOUR = 12;           // Delta India BTC options settle 17:30 IST = 12:00 UTC
frontend/index.html:22016:          const r = indexedDB.open('btc_desk_market_cache', 1);
frontend/index.html:22046:      const u = API + '/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=BTC&expiry_date=' + encodeURIComponent(apiDa
frontend/index.html:22056:      return (u === 'BTC' || s.includes('BTC')) && /^[CP]-BTC-/.test(s);
frontend/index.html:22059:      const m = String(symbol || '').match(/^[CP]-BTC-[^-]+-(\d{6})$/i);
frontend/index.html:22069:      setBadge('warn', 'Searching'); setText('status', 'Finding BTC option expiries…');
frontend/index.html:22073:          const x = JSON.parse(localStorage.getItem('btc_expiry_list_v1') || 'null');
frontend/index.html:22093:        if (found.length) try { localStorage.setItem('btc_expiry_list_v1', JSON.stringify({ at: Date.now(), list: found })); } catch (e) { }
frontend/index.html:22097:          : '<option value="">No BTC options found</option>';
frontend/index.html:22106:          selected = ''; setBadge(false, 'No data'); setText('status', 'No live or upcoming BTC option expiry found.');
frontend/index.html:22129:      const symbol = String(x.symbol || ''), m = symbol.match(/^[CP]-BTC-([0-9]+(?:\.[0-9]+)?)-/i);
frontend/index.html:22289:       Shape: mean squared 30m log return of the BTC index per IST half-hour slot
frontend/index.html:22437:        version: 31, format: 'compact-v1', app: 'btc-atm-iv', savedAt: Date.now(),
frontend/index.html:22607:      a.download = 'BTC_ATM_IV_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
frontend/index.html:22644:        backupFileHandle = await window.showSaveFilePicker({ suggestedName: 'BTC_ATM_IV_AUTO_BACKUP.json', types: [{ description: 'BTC IV backup
frontend/index.html:22682:      return `BTC-${d}${m}${y.slice(-2)}`;
frontend/index.html:22720:        const symbol = String(d?.s || ''), m = symbol.match(/^[CP]-BTC-([0-9]+(?:\.[0-9]+)?)-/i);
frontend/index.html:22797:        const btc = rows.filter(isBTCOption);
frontend/index.html:22798:        if (!btc.length) throw new Error('no BTC option contracts returned');
frontend/index.html:22799:        const parsed = parseRows(btc);
frontend/index.html:22853:    const CANDLE_KEY = 'btc_atm_iv_candles_v1';
frontend/index.html:22855:    const CHART_PREF_KEY = 'btc_atm_iv_chart_prefs_v1';
frontend/index.html:23007:        const symbol = String(d?.s || ''), m = symbol.match(/^[CP]-BTC-([0-9]+(?:\.[0-9]+)?)-/i), e = expiryFromSymbol(symbol);
frontend/index.html:23297:        const h = d ? `<span class="pane-gap" title="Delta has not listed BTC options for ${d} yet. The chart shows this slot's history up to th
frontend/index.html:23337:        p.chart.applyOptions({ watermark: { fontSize: cw < 520 ? 17 : 30, text: p.expiry ? (cw < 520 ? `ATM IV  ${p.expiry.slice(5)}` : `BTC ATM
frontend/index.html:23521:          watermark: { visible: true, fontSize: 30, horzAlign: 'center', vertAlign: 'center', text: 'BTC ATM IV' },
frontend/index.html:23607:    const BACKFILL_KEY = 'btc_atm_iv_backfill_v1';
frontend/index.html:23709:      else { const s = validSpot(liveSpot) ? liveSpot : restSpot; if (!validSpot(s)) throw new Error('no BTC spot'); lo = s * (1 - pad); hi = s 
frontend/index.html:23804:    const ROLL_DAYS = 365, ROLL_FINE_DAYS = 30, ROLL_DEPTH = 4, ROLL_KEY = 'btc_atm_iv_roll_v1';   // v71: a year (was 30 days); older than 30 d
frontend/index.html:23834:        if (!idx.length) throw new Error('BTC index history unavailable');
frontend/index.html:23848:          let probe = [];      // one cheap request first: skip dates that had no BTC expiry
frontend/index.html:23850:          for (const t of ['C', 'P']) { if (probe.length) break; try { probe = await getHistory(`MARK:${t}-BTC-${atmK}-${code}`, res, start, end
frontend/index.html:23859:          const syms = []; for (const K of Ks) for (const type of ['C', 'P']) syms.push({ symbol: `${type}-BTC-${K}-${code}`, K, type });
frontend/index.html:23923:    /* ---------- event calendar: scheduled releases that move BTC volatility ----------
frontend/index.html:23962:      FED: 'The press conference often moves BTC more than the statement.', CPI: 'Top data release for crypto. Expect a fast move at the print, 
frontend/index.html:23964:      PPI: 'Pipeline inflation; moves BTC when it surprises.', JOLTS: 'Labour-market read; modest impact.', MIN: 'Fed minutes at 14:00 ET: can j
frontend/index.html:23967:      DBX: 'Deribit BTC options expiry at 13:30 IST: pinning before, release after.', CUS: 'Your own event.'
frontend/index.html:23969:    const EV_CUSTOM_KEY = 'btc_vol_events_custom_v1', EV_PREF_KEY = 'btc_vol_events_pref_v1';
frontend/index.html:23986:          out.push({ t: Date.UTC(y, m - 1, d, 8, 0), code: 'DBX', title: q ? 'Deribit QUARTERLY BTC options expiry' : lastFri ? 'Deribit monthly
frontend/index.html:24035:    // IV and BTC reaction around a past event (rolling current-expiry IV, 30-minute BTC bars)
frontend/index.html:24065:       BTC reaction sizes, not fitted; the "last time" figure is the measured range when the
frontend/index.html:24108:      if (x.last != null) bits.push(`<span title="BTC index range from 30m before to 2h after the previous release">Last <b>${(x.last * 100).toF
frontend/index.html:24133:        const react = r ? `<small>IV ${r.iv != null ? (r.iv > 0 ? '+' : '') + r.iv.toFixed(2) + ' pts' : '—'} · BTC range ${r.mv != null ? (r
frontend/index.html:24139:        (past.length ? `<tr class="ev-sep"><td colspan="4">Last 10 days, with the IV and BTC reaction</td></tr>` + past.map(e => row(e, true)).j
frontend/index.html:24328:       - Realized vol from the Delta BTC index (.DEXBTUSD), HAR-RV forecast
frontend/index.html:24335:    const DESK_PREF_KEY = 'btc_vol_desk_prefs_v1';
frontend/index.html:24422:          const x = await mcGet('btc_px_hist_v1'); if (x && Array.isArray(x.h) && x.h.length) {
frontend/index.html:24435:        if (!desk.px1h.length) throw new Error('Delta returned no BTC index history');
frontend/index.html:24438:        const pk = a => a.map(b => [b.t, b.o, b.h, b.l, b.c]); mcPut('btc_px_hist_v1', { h: pk(desk.px1h), m: pk(desk.px30), at: Date.now() });
frontend/index.html:24593:      if (!desk.px30.length) { const h = `<tr><td colspan="8" class="sess-msg">${desk.volErr ? 'Could not load BTC index history from Delta (' +
frontend/index.html:24607:      setText('sessNote', `BTC index range vs its 20-session average · ATM IV of ${selected || 'the selected expiry'} · ${SessCal.describe(Dat
frontend/index.html:24619:      const rows = await dbGet('get_book_summary_by_currency', { currency: 'BTC', kind: 'option' });
frontend/index.html:24622:        const p = String(r.instrument_name || '').split('-'); if (p.length !== 4 || p[0] !== 'BTC') continue;
frontend/index.html:24704:       hold with IV rising spotVol vol points for every 1% BTC moves (wings bid up on a move).
frontend/index.html:24900:      setText('scFoot', `Hold 1σ ${C.sig ? '±' + dPts(C.sig) : '—'}, 1σ to settlement ${C.sigExp ? '±' + dPts(C.sigExp) : '—'} from ATM 
frontend/index.html:24937:       - Source: Delta BTC index (.DEXBTUSD) 1-minute candles
frontend/index.html:24946:      const RV_PREF_KEY = 'btc_rv_overlay_prefs_v1';
frontend/index.html:25017:            status('Loading BTC index 1-minute history…');
frontend/index.html:25037:      /* v71 · a year of 5-minute BTC index candles. The 1-minute store above still covers the latest 28 days and drives
frontend/index.html:25038:         everything live; on 15m-and-longer charts the BTC·γ candles and the RV candles reach back up to 365 days through
frontend/index.html:25133:         RV -> IV -> VoV rule needs a real calm. Fast RV and the grind check come from 1-minute BTC index returns
frontend/index.html:25216:      // screen (it follows the BTC index to the second), so the engine reads exactly what the panel shows
frontend/index.html:25397:        if (!b) { box.innerHTML = head + `<span class="dim">${RV.bars.size ? 'no data at this bar' : 'loading BTC index…'}</span>`; return; }
frontend/index.html:25410:          if (q) { const t = K.tone(q), ar = q.falling ? ' ▼' : q.rising ? ' ▲' : ''; spd = `<span class="spd-chip ${t}" title="Speed of the
frontend/index.html:25444:         the forming RV candle is re-marked from the live BTC index every couple of seconds using the
frontend/index.html:25519:        if (RV.err) return status(`Couldn't load BTC index (${RV.err}). Retrying.`);
frontend/index.html:25520:        if (!RV.bars.size) return status('Loading BTC index 1-minute history…');
frontend/index.html:25522:        status(`BTC index, 1-min returns, annualised${RV.full ? '' : ' · loading older history'} · updated ${age < 5 ? 'just now' : age < 90 ?
frontend/index.html:25964:       - BTC index pane with the dealer-gamma model drawn on the chart:
frontend/index.html:25977:      /* ---------------- BTC index candles ---------------- */
frontend/index.html:26015:        G.chart.applyOptions({ watermark: { visible: true, fontSize: 30, horzAlign: 'center', vertAlign: 'center', text: 'BTC' } });
frontend/index.html:26080:        G.chart.applyOptions(chartThemeOptions()); G.chart.applyOptions({ watermark: { visible: true, text: 'BTC' } });
frontend/index.html:26120:        const head = `<b class="lg-title">BTC</b><span class="lg-title">Delta index</span><b class="lg-tf">${chartPrefs.tf}</b>`;
frontend/index.html:26175:         Dealer book delta D = Σ sign·Δ·OI (BTC), same sign convention as the gamma profile.
frontend/index.html:26177:           trade is −ΔD (positive = they buy BTC). Exact reprice, not the linear charm Greek,
frontend/index.html:26203:        const charm = -(dealerDelta(opts, S, now, tA + tH, 0) - DA);        // BTC dealers trade across the hold from time alone
frontend/index.html:26212:         Two nights are tested, each as the BTC dealers must trade across the hold:
frontend/index.html:26227:        const fB = f => `${f >= 0 ? 'buy' : 'sell'} ${Math.abs(f) >= 10 ? Math.round(Math.abs(f)) : Math.abs(f).toFixed(1)} BTC (≈ a ${eq(f)?.
frontend/index.html:26257:        const flow = f => `dealers ${f >= 0 ? 'buy' : 'sell'} ${sz(f)} BTC`;
frontend/index.html:26264:        if (hot) parts.push(imp.st === 3 ? 'BTC impulse, wait' : 'BTC fast, wait');
frontend/index.html:26277:            text: !imp.ok ? (imp.behind ? 'No speed reading: the BTC index feed is behind.' : 'No speed reading yet: waiting for 1-minute BTC ca
frontend/index.html:26278:              : hot ? `BTC ${imp.st === 3 ? 'impulse' : 'is fast'} (${x} normal)${way}. Entry gate shut.`
frontend/index.html:26279:                : imp.wait ? `BTC ${imp.st === 0 ? 'is calm' : 'speed is normal'} (${x})${way}. Entry gate: wait ${imp.wait} min.`
frontend/index.html:26280:                  : imp.st === 0 ? `BTC is calm for this hour (${x} normal speed)${way}.` : `BTC speed is normal for this hour (${x})${way}.`
frontend/index.html:26332:          return `<b class="${buy ? 'gx-up' : 'gx-dn'}">${buy ? '▲ buy' : '▼ sell'} ${sz}<i class="gx-u"> BTC</i></b><small>${dUsd(usd).repl
frontend/index.html:26338:          `<span class="gx-seg" data-k="charm" title="Charm: over ${X.inWin ? 'the rest of your hold' : 'your 21:00–07:00 hold'} (${X.hrs.toFi
frontend/index.html:26339:          `<span class="gx-seg" data-k="vanna" title="Vanna: if every option's IV falls 1 vol point (typical overnight bleed), dealer deltas shi
frontend/index.html:26445:        else { const r = evReaction(e); if (r) body = `<div class="pop-stats"><span>IV <b class="${r.iv > 0 ? 'cd' : 'cu'}">${r.iv != null ? (r.
frontend/index.html:26544:      // v71: load enough BTC history to show chart time t (used by "Go to date"); returns the first time available
frontend/index.html:26569:       - History: 30-minute BTC bars, reduced to one summary per 21:00–07:00 IST night and
frontend/index.html:26594:         Built from 30-minute BTC bars. 21:00 IST = 15:30 UTC, which hourly bars cannot
frontend/index.html:26604:          const rs = await Promise.all(jobs.slice(i, i + 6).map(s => j(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=30m&limit=
frontend/index.html:26632:        for (const [src, fn] of [['Binance BTCUSDT', binance30], ['Delta BTC index', delta30]]) {
frontend/index.html:26799:       BTC implied vol behaved around past prints (Deribit minute DVOL, 4 h
frontend/index.html:26800:       before to 11 h after), how often it cooled or stayed bid, how far BTC
frontend/index.html:26880:            try { j = await getJSONNow(`${DERIBIT_API}/get_volatility_index_data?currency=BTC&start_timestamp=${Math.floor(from)}&end_timestamp=
frontend/index.html:26899:          const a = await getJSONNow(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${Math.floor(from)}&endTime=${M
frontend/index.html:27167:        // 30-minute BTC index, 420 days
frontend/index.html:27216:       Every candle chart (both IV panes, their realised-vol panels and BTC · γ) gets a live countdown to
frontend/index.html:27255:      // IV panes (live expiry only) and the BTC index chart
frontend/index.html:27264:      attach(() => !window.__lpTag && window.__gexChart && window.__gexSeries ? { chart: window.__gexChart, series: window.__gexSeries, box: doc
frontend/index.html:27675:      const VIEW_KEY = 'btc_iv_pane_view_v1', VIEWS = ['auto', 'all', 'rv', 'vov', 'iv'], VLAB = { auto: 'Auto', all: 'Everything', rv: 'IV + RV
frontend/index.html:27709:       v49 — Impulse meter (BTC · gamma pane)
frontend/index.html:27710:       Question answered, live: "How fast is BTC moving right now compared with what is
frontend/index.html:27712:       Source: the Delta BTC index 1-minute candles the RV module already keeps (up to
frontend/index.html:27739:      const PREF_KEY = 'btc_impulse_prefs_v1';
frontend/index.html:27748:      // CME bitcoin futures are shut from Friday 21:00 UTC to Sunday 22:00 UTC: BTC is slower then, so it gets its own baseline
frontend/index.html:27896:        if (!x || !x.ok) return `<span class="gx-seg gx-imp na" ${head} title="Impulse meter: ${x ? 'the BTC index feed is behind' : 'waiting fo
frontend/index.html:27898:        return `<span class="gx-seg gx-imp s${x.st}" ${head} title="Impulse meter: BTC speed over the last 5 minutes against normal for this tim
frontend/index.html:27914:        pop.innerHTML = `<div class="pop-h"><b>Impulse meter</b><span>BTC index · last 5 min</span><button type="button" class="pop-x" aria-lab
frontend/index.html:27936:          h = row('na', x ? 'The BTC index feed is behind' : 'Waiting for BTC index history',
frontend/index.html:27957:            `The last 5 minutes as a yearly rate, adjusted for time of day. Above 1× BTC is moving faster than the IV you sell pays for.`);
frontend/index.html:27970:          note = `Delta BTC index, 1-minute candles, ${dTxt} days. Normal is the median for the same 45-minute slot of the day, weekdays and wee
frontend/index.html:28093:       The charts on Deribit's BTC options metrics page, in 15-minute windows and live:
frontend/index.html:28101:       Source: public/get_last_trades_by_currency_and_time (BTC, options), read every 10 s.
frontend/index.html:28117:      const PREF_KEY = 'btc_dflow_prefs_v1';
frontend/index.html:28148:        const q = new URLSearchParams({ currency: 'BTC', kind: 'option', start_timestamp: String(Math.floor(from)), end_timestamp: String(Math.f
frontend/index.html:28321:        if (sub) sub.textContent = `BTC · last 15 min: ${big(N.all.amt)} contracts in ${num(N.all.n)} trades`;
frontend/index.html:28367:       v16 · BTC · γ chart layer
frontend/index.html:28376:       Reads only what the terminal already loads (Delta BTC index 1m candles, the
frontend/index.html:28977:         were still built and repainted every second while hidden; deleted. Only the BTC-chart hooks it carried stay. */
frontend/index.html:29067:          `<p class="pa-note">Vol turn reads the RV, IV and VoV candles of the expiry picked here, at any hour. RV leads: red candles in a row m
frontend/index.html:29120:          const wmD = document.body.classList.contains('wm') || innerWidth > 760;   // v70/v80: on the desktop the BTC chart keeps the larger sh
frontend/index.html:29125:          if (FS) { volH = vOn ? clamp(Math.round(avail * FS.vol), 120, Math.round(avail * 0.45)) : 0; chartH = avail - volH; }   // v47: the in
frontend/index.html:29127:          const core = !FS && innerWidth >= 1025 && !!el('v22Top');   // v105.23: desktop — the BTC candles are the core; ADX is a short strip
frontend/index.html:29168:       v54 · ADX candles and ATR bars under the BTC·γ chart (14 periods, chart timeframe)
frontend/index.html:29173:       - Same bars as the BTC chart (read from the BTC·γ layer), scrolled and zoomed with it.
frontend/index.html:29211:        // scroll / zoom together with the BTC chart (both carry the same bar times)
frontend/index.html:29214:        // time hairline: the BTC chart's crosshair is drawn here at the same candle, and touching this panel moves the BTC one
frontend/index.html:29248:        //      the canvas and stay locked under the BTC candles. Rising = green, falling = red, faded below 25.
frontend/index.html:29285:        if (!D) { box.innerHTML = '<b>ADX 14</b><span class="dim">waiting for BTC candles…</span>'; return; }
frontend/index.html:29297:      // session-start hairlines (Asia day line solid, London / New York dashed), on any chart that shares the BTC bars
frontend/index.html:29325:       v60 · Drawing tools on the BTC·γ chart, and desktop full screen
frontend/index.html:29334:      const KEY = 'btc_drawings_v1', COLS = ['#5AA9E6', '#E3AE45', '#EF5A5E', '#35BB7D', '#B48CF2', '#E6EDF3'];
frontend/index.html:29461:          if (b.classList.contains('dw-del')) { if (S.sel) { D = D.filter(x => x.id !== S.sel); S.sel = null; } else if (D.length && confirm(`Re
frontend/index.html:29519:          const paintFs = () => { const on = document.body.classList.contains('gfs-max'); fb.innerHTML = on ? '<svg viewBox="0 0 24 24"><path d=
frontend/index.html:29520:          // v67: full screen is the whole desk in browser full screen with the BTC window filling the window area: the desk
frontend/index.html:29543:       BTC·γ, the three IV charts, their RV panels and their VoV panels all get the
frontend/index.html:29570:      // v105.4: the indicator panes under the BTC chart get the same live value + countdown (ADX, Edge, Range)
frontend/index.html:29644:       v63 · BTC·γ zoom: −, +, and back to live, eased; keys − + 0 over the chart.
frontend/index.html:29648:    (function btcZoom() {
frontend/index.html:30248:          note: e.leg === 'iv' ? 'IV turned up with speed and size: the vol fall may be over.' : 'A big BTC move just printed: the stop can come
frontend/index.html:30473:       v20 · Session ranges on the BTC·γ chart
frontend/index.html:30479:       Data: the Delta BTC index, 15-minute candles, 24 days back, refreshed every 20 s. Layers menu: "Session table"
frontend/index.html:30545:          h = head + `<div class="sr-b"><table><caption class="sr-cap">Range of each session now against its 20-day average, in BTC points</capt
frontend/index.html:30601:       v21 · Session separators on the BTC·γ chart
frontend/index.html:30652:         btc     every 1-minute BTC index candle, one record per IST day (RV and VoV can be rebuilt from these)
frontend/index.html:30655:         events  every vol-turn signal (all falling / all rising / danger) with BTC and IV at that moment
frontend/index.html:30663:      const DBN = 'suraj_archive_v1', ST = ['iv', 'btc', 'flow', 'nights', 'events', 'meta', 'days'], MIN = 1440, DAYMS = 86400000, ISTMS = 1980
frontend/index.html:30704:      const mark = { iv: {}, btc: 0, n: {} };
frontend/index.html:30730:        const from = full ? -Infinity : mark.btc - 180000, groups = new Map(); let mx = mark.btc;
frontend/index.html:30732:        mark.btc = mx; if (!groups.size) return 0;
frontend/index.html:30733:        const cur = await getMany('btc', [...groups.keys()]), now = Date.now(), out = [];
frontend/index.html:30738:        await putMany('btc', out); return out.length;
frontend/index.html:30784:        for (const s of ['iv', 'btc', 'flow', 'nights', 'events', 'days']) { const rows = (await getAll(s)).filter(([k, v]) => !since || (v && v
frontend/index.html:30818:                else if (s === 'iv' || s === 'btc') { for (const f2 of ['o', 'h', 'l', 'c']) for (let m = 0; m < MIN; m++)if (Number.isNaN(o[f2]
frontend/index.html:30864:      // "did BTC stay inside ±1σ" check is a few array reads instead of thousands of date lookups (about 50x faster).
frontend/index.html:30883:        const [btcRows, evRows, nightRows, flowRows] = await Promise.all([getAll('btc'), getAll('events'), getAll('nights'), getAll('flow')]);
frontend/index.html:30884:        const B = makeBtc(btcRows), now = Date.now(), out = { btcDays: btcRows.length };
frontend/index.html:30998:        out.counts = { iv: await countOf('iv'), btc: btcRows.length, flow: flowRows.length, nights: nightRows.length, events: evRows.length };
frontend/index.html:31030:            `<div class="lp-why"><span>Vol turn now: <b>${esc(st)}</b>${R.vt.fall[8] != null ? ` (after all three fell, BTC stayed inside for 8 
frontend/index.html:31037:              `IV ${g.pct == null ? '—' : fP(g.pct)} · BTC ${g.inside == null ? '—' : g.inside ? 'stayed inside ±1σ' : 'broke out'}`))) +
frontend/index.html:31041:          `<div class="lp-kv"><span><b>${c.iv}</b> IV expiry-days</span><span><b>${c.btc}</b> BTC days</span><span><b>${c.flow}</b> flow bars</s
frontend/index.html:31094:        h += `<div class="lp-sec"><div class="lp-h"><b>All three falling: did BTC stay sideways?</b><small>inside ±1σ (24 h realised)</small><
frontend/index.html:31096:        if (!V.fall.n4 && !V.fall.n8) h += `<p class="lp-n">Collecting: ${V.fall.n} signal${V.fall.n === 1 ? '' : 's'} saved, each needs its nex
frontend/index.html:31122:        const fs = (who, did, happened, r, n, base, hi) => { const v = verdictF(r, base, n, hi); return `<div class="lp-fs"><p>When <b>${who}</b
frontend/index.html:31124:          `<p class="lp-n">Selling options = betting BTC stays calm. Buying options = betting on a big move. Each hour where one side traded 20%
frontend/index.html:31127:          `<p class="lp-n">Calm = BTC stayed inside its normal 4-hour range (±1σ). Flow history only starts when this terminal began saving it
frontend/index.html:31196:       - BTC·γ chart: tap (or click) any candle: a card with the time and session, OHLC, the candle pattern, swing label,
frontend/index.html:31281:      function hookChart() { return true; }   // v81: a tap or click on the BTC chart opens nothing (candle card removed at his request; show() 
frontend/index.html:31382:    /* v40 · "to now" arrow: appears on the IV / RV / VoV charts and the BTC chart when the view is scrolled away from the
frontend/index.html:31391:        // the jump also resets the user-moved flag and re-frames like the desk does on load, on the IV charts and the BTC chart
frontend/index.html:31408:        try { const g = window.__gexChart, host = document.getElementById('chartG')?.parentElement; if (g) { if (window.__gexSeries && !g.__seri
frontend/index.html:31450:       v64 · Full-screen split and the left tool column on the BTC·γ chart (layout only)
frontend/index.html:31512:       - One shared store of Deribit's BTC volatility index (DVOL): 1-minute
frontend/index.html:31549:            try { j = await getJSONNow(`${DERIBIT_API}/get_volatility_index_data?currency=BTC&start_timestamp=${Math.floor(from)}&end_timestamp=
frontend/index.html:31876:        return [`<span class="meta-chip dv ${V.c}" title="${esc(`DVOL (Deribit 30-day BTC vol) is ${V.d.label} on 15m candles: ${V.d.why}.${k1 !
frontend/index.html:31959:       Around one print at time t (DVOL = Deribit 30-day BTC vol, 1-minute):
frontend/index.html:31968:                                     and BTC's range since the print is within
frontend/index.html:31971:                                     still up (≥ +0.5) and BTC still running.
frontend/index.html:31983:         BTC direction and size in σ, DVOL vs pre level, and the 25Δ skew
frontend/index.html:32029:      /* ---------- BTC around a print (Delta index, 1-minute; Binance as a fallback) ---------- */
frontend/index.html:32041:          const a = await getJSONNow(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${Math.floor(from)}&endTime=${M
frontend/index.html:32072:        // BTC
frontend/index.html:32151:          G.why = `Early read: IV ${R.cooled ? 'already back to its pre-print level' : R.elev ? 'still well above its pre-print level' : 'easing
frontend/index.html:32154:        if (R.rangeS == null) { G.st = 'wait'; G.sub = 'BTC loading'; G.why = `IV ${R.cooled ? 'is back to its pre-print level' : 'is ' + sg(R.c
frontend/index.html:32156:          if (R.cooled && !R.spikeBig && R.calm) { G.st = 'open'; G.exp = expiryFor(true, true); G.sub = G.exp.pick; G.why = `IV is back within 
frontend/index.html:32157:          else if (R.cooled && (R.spikeBig || !R.calm)) { G.st = 'small'; G.exp = expiryFor(true, false); G.sub = G.exp.pick; G.why = `IV cooled
frontend/index.html:32165:        if (R.elev && R.running) { G.st = 'skip'; G.sub = 'IV up, price running'; G.why = `Two hours on, IV is still ${sg(R.cur)} DVOL above the
frontend/index.html:32166:        if (R.cooled && !R.running) { G.st = 'open'; G.exp = expiryFor(true, R.rangeS <= 1.3); G.sub = G.exp.pick; G.why = `IV has settled${R.co
frontend/index.html:32168:        G.sub = G.exp.pick; G.why = `Mixed after ${anchor.name}: IV ${R.cooled ? 'cooled' : 'still ' + sg(R.cur) + ' above'}, BTC ${R.running ? 
frontend/index.html:32196:          // fetch BTC for the prints that matter, then decide again with it
frontend/index.html:32213:       v68 · BTC·γ tool rail: zoom and drawing tools move out of the plot
frontend/index.html:32249:       v71 · Price-cross alerts (BTC and the IV charts) and chart replay (all charts)
frontend/index.html:32250:       Alerts: "Alerts" in the BTC·γ tool row, then tap a price on the BTC chart or
frontend/index.html:32254:         btc_alerts_v1. IV alerts follow the chart's slot (Current / Next / ...).
frontend/index.html:32255:       Replay: "Replay", then tap a candle on any chart. Every chart (BTC, IV, RV,
frontend/index.html:32291:      const KEY = 'btc_alerts_v1';
frontend/index.html:32294:      const isBtc = a => a.tgt === 'btc';
frontend/index.html:32296:      const label = a => isBtc(a) ? 'BTC' : `${relName(a.tgt.slice(3))} IV`;
frontend/index.html:32312:        const a = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), tgt, price: tgt === 'btc' ? Math.round(price) : Math.r
frontend/index.html:32395:      // placing by tap: any BTC or IV chart, while "add by tap" is on
frontend/index.html:32398:        if (chart === window.__gexChart) return { tgt: 'btc', s: window.__gexSeries };
frontend/index.html:32399:        try { if (window.Regime && window.Regime.btc && chart === window.Regime.btc().chart) return { tgt: 'btc', s: window.Regime.btc().series 
frontend/index.html:32409:        if (on) { unlockAudio(); const h = showHint('Tap a price on the BTC chart or an IV chart to set an alert', [['done', 'Done']]); h.onclic
frontend/index.html:32418:        const opts = [['btc', 'BTC']];
frontend/index.html:32420:        const sel = pan.querySelector('#alTgt')?.value || 'btc';
frontend/index.html:32424:          `<input id="alPx" type="number" inputmode="decimal" step="any" placeholder="${sel === 'btc' ? 'BTC price' : 'IV %'}" aria-label="Level
frontend/index.html:32541:              const T = chartTarget(e.chart); if (!T) { showHint('Alerts work on the BTC chart and the IV charts', [['done', 'Done']]); return; 
frontend/index.html:32565:        // load enough history on the BTC chart and the IV charts to reach T
frontend/index.html:32609:      /* ================= buttons in the BTC·γ tool row ================= */
frontend/index.html:32614:          `<button type="button" class="x-b" id="alBtn" aria-pressed="false" title="Price alerts: tap a level on the BTC or an IV chart, or type
frontend/index.html:32645:engine's panes live on each page, the pane tabs of the vol row, the BTC
frontend/index.html:32661:      let page = (LS('v80_page') === 'pgBot' || LS('v80_page') === 'pgPaper' || LS('v80_page') === 'pgAlgo' || LS('v80_page') === 'pgScore') ? L
frontend/index.html:32728:      /* ---------- BTC chart platform chrome ---------- */
frontend/index.html:32785:      /* ---------- replay / go-to: every indicator pane follows the BTC chart's range ----------
frontend/index.html:32787:         (BTC chart = master) a few times after each replay event. */
frontend/index.html:32800:      /* cold start: the BTC chart is the master; if nobody has touched it, land on the live edge once the panes have settled */
frontend/index.html:32804:        //      BTC chart; checking only at 3.5 / 7 / 12 s missed loads that finish later (desktop opened on a week-old day).
frontend/index.html:32814:      /* v82: the BTC chart opens on the saved range (default 1D) and keeps it when the timeframe changes */
frontend/index.html:32941:       for the Suraj Vishwakarma Volatility Desk (BTC short strangle, Delta Exchange India).
frontend/index.html:32965:        const NEWS_RE = /bitcoin|btc|crypto|\bsec\b|etf|\bfed\b|federal reserve|hack|exploit|exchange|binance|coinbase|tariff/i;
frontend/index.html:32980:           move1h   = BTC 1-h range multiple vs a normal hour. Volmex hourly panel (Sep 2022–Sep 2024): announcement-hour
frontend/index.html:33115:        const DRB_RE = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/;      // BTC-9OCT26-120000-C (no leading zero), 08:00 UTC
frontend/index.html:33127:          }                       // open_interest in BTC (1 contract = 1 BTC)
frontend/index.html:33135:              t, code: 'DERIBIT_EXP', src: 'deribit-expiry', pri: 2, imp, region: 'crypto', oi: r.oi, oiAtm: r.atm, kind, top, title: 'Deribit '
frontend/index.html:33136:              small: top ? 'top-decile ATM OI → pre-expiry drift' : 'ATM OI ' + fmtBtc(r.atm) + ' BTC'
frontend/index.html:33144:        // OI in BTC, same precedence as the engine's deltaOiBtc() (5372): oi_value_usd/spot → oi_contracts×contract_value → oi
frontend/index.html:33156:            const type = /^C-BTC-/.test(sym) || ct === 'call_options' ? 'C' : (/^P-BTC-/.test(sym) || ct === 'put_options' ? 'P' : null); if (!t
frontend/index.html:33164:            title: 'Delta expiry' + (chain && chain.oi > 0 ? ' · ' + fmtBtc(chain.oi) + ' BTC OI' : ''), small: (SLOT[slot] || '') + (chain && 
frontend/index.html:33278:            const book = await gJSON(DRB + 'get_book_summary_by_currency?currency=BTC&kind=option', 20000);
frontend/index.html:33289:            const rs = await Promise.allSettled(exps.map(x => gJSON(DLT + '/v2/tickers?contract_types=call_options,put_options&underlying_asset_
frontend/index.html:33475:      const OKX_LIQ = 'https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=BTC-USD&state=filled';
frontend/index.html:33476:      const DERIBIT_TRADES = 'https://www.deribit.com/api/v2/public/get_last_trades_by_currency?currency=BTC&kind=option&count=100';
frontend/index.html:33477:      const DELTA_CONTRACT_BTC = 0.001;            // Delta India BTCUSD perp: 1 contract = 0.001 BTC (assumption, see orderflow.md)
frontend/index.html:33478:      const OKX_INVERSE_FACE_USD = 100;             // OKX BTC-USD-SWAP (inverse): 1 contract = $100 face
frontend/index.html:33479:      const OKX_LINEAR_BTC = 0.01;                  // OKX BTC-USDT-SWAP: 1 contract = 0.01 BTC
frontend/index.html:33670:      async function pollTicker() { const j = await getJ(`${DELTA}/tickers/BTCUSD`, 8000); const r = j && (j.result || j); if (r && (r.mark_pric
frontend/index.html:33672:        const j = await getJ(`${DELTA}/l2orderbook/BTCUSD?depth=20`, 4000); const r = j && (j.result || j); if (!r) return;
frontend/index.html:33676:        const j = await getJ(`${DELTA}/trades/BTCUSD`, 5000); const r = j && (j.result || j), list = Array.isArray(r) ? r : (r && (r.trades || r
frontend/index.html:33691:      const KL_HOSTS = ['https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT', 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT', 'https
frontend/index.html:33733:        const rows = (await candles('FUNDING:BTCUSD', '1h', a, mid)).concat(await candles('FUNDING:BTCUSD', '1h', mid, now));
frontend/index.html:33738:        const h = await candles('OI:BTCUSD', '1h', now - 2 * 86400, now); if (h.length > 12) { S.oi1h = { at: Date.now(), rows: h.map(c => [c.t,
frontend/index.html:33739:        const d = await candles('OI:BTCUSD', '1d', now - 366 * 86400, now); if (d.length > 30) { S.oi1d = { at: Date.now(), hi: Math.max(...d.ma
frontend/index.html:33794:      // 90-d FUNDING:BTCUSD closes in the ticker's unit: the candle unit is not documented, so a 100× gap against the live print
frontend/index.html:33852:<b>CVD 15m</b><span class="v num ${cls(st.delta15)}">${sgn(st.delta15, 0)} BTC</span>
frontend/index.html:33947:       v80 · Signal — BTC short-strangle 24×7 score, plan and exit stack
frontend/index.html:34082:          const j = await netJSON(`${DERIBIT}/get_book_summary_by_currency?currency=BTC&kind=option`, 15000); const rows = Array.isArray(j?.resu
frontend/index.html:34084:            const p = String(r.instrument_name || '').split('-'); if (p.length !== 4 || p[0] !== 'BTC') continue; const m = /^(\d{1,2})([A-Z]{3}
frontend/index.html:34097:          const api = typeof W.API === 'string' ? W.API : DELTA_API; const j = await netJSON(`${api}/v2/tickers?contract_types=call_options,put_
frontend/index.html:34255:      /* ---------- 2. BTC header chips: open the dealer-flow read under the header ---------- */
frontend/index.html:34298:      const NAME = id => { const m = /^(chart|rvChart|vovChart|dvChart)(\d)$/.exec(id); if (m) return { chart: 'IV', rvChart: 'RV', vovChart: 'V
frontend/index.html:34427:      const PREF_KEYS = ['btc_atm_iv_theme_v132', 'btc_atm_iv_theme_v122', 'btc_atm_iv_theme', 'btc_iv_pane_view_v1', 'gfs_split_v1', 'btc_atm_i
frontend/index.html:34428:        'btc_vol_desk_prefs_v1', 'btc_vol_events_pref_v1', 'edge_rank_prefs_v1', 'ivprob_pref_v1', 'pa_layer_prefs_v2', 'pa_layer_prefs_v3', 'dv
frontend/index.html:34440:          if ($('rsDraw')?.checked) { localStorage.removeItem('btc_drawings_v1'); localStorage.removeItem(KEY); }
frontend/index.html:34441:          if ($('rsAlert')?.checked) localStorage.removeItem('btc_alerts_v1');
frontend/index.html:34452:       time label, the BTC legend shows the candle size under the cursor, and
frontend/index.html:34462:      function groupOf(el) { const id = el && el.id || ''; if (/^(chartG|paVol|paAdx|ofBox)$/.test(id)) return 'btc'; const m = /^(chart|rvChart
frontend/index.html:34512:            if (g === 'btc') sizeAt(t);
frontend/index.html:34519:      /* ---------- 3. BTC candle size under the cursor ---------- */
frontend/index.html:34554:       v83 · Regime page — Week / Month / Year view of BTC, IV, RV, VoV, DVOL,
frontend/index.html:34558:         BTC   Delta .DEXBTUSD hourly; Binance BTCUSDT hourly where Delta has none
frontend/index.html:34595:        const j = await getJ(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${s}&end_timestamp=${
frontend/index.html:34607:              const j = await getJ(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${a}&endTime=${Math.min(e, a + 10
frontend/index.html:34824:      const CH = { btc: 'regBtcCh', vpi: 'regVpiCh', adx: 'regAdxCh', iv: 'regIvCh', vov: 'regVovCh', rv: 'regRvCh', dvol: 'regDvolCh' };
frontend/index.html:34830:   <div class="ph80">Regime<span class="rg-sub">BTC · IV · RV · VoV · DVOL</span><span class="sp"><span class="rg-seg" role="tablist">${['we
frontend/index.html:34833:   ${pane('btc')}
frontend/index.html:34854:          autoSize: true, rightPriceScale: { borderVisible: false, minimumWidth: 76, scaleMargins: k === 'btc' ? { top: 0.2, bottom: 0.08 } : k 
frontend/index.html:34855:          timeScale: { visible: axis, borderVisible: false, rightOffset: k === 'btc' || k === 'vpi' || k === 'adx' ? 4 : 2, barSpacing: k === 'b
frontend/index.html:34863:          const pf = k === 'btc' || k === 'vpi' || k === 'adx' ? { type: 'price', precision: 0, minMove: 1 } : { type: 'price', precision: 1, mi
frontend/index.html:34874:            else if (k !== 'btc') { o.p80 = c.addLineSeries(Object.assign({ color: 'rgba(90,169,230,.6)' }, lineOpts)); o.p20 = c.addLineSeries(
frontend/index.html:34876:            if (k === 'btc') o.lines = [];
frontend/index.html:34882:        // BTC · VPI · ADX share one time axis; the four vol charts share theirs
frontend/index.html:34884:        link(['btc', 'vpi', 'adx']); link(VOL.map(v => v[0]));
frontend/index.html:34906:        C.btc.main.setData(B.px.map((c, i) => { const d = cdl(c, i); if (W.RegLayers && W.RegLayers.on()) { const z = 'rgba(0,0,0,0)'; d.color =
frontend/index.html:34917:        M.sort((a, b) => a.time - b.time); try { C.btc.main.setMarkers(M); } catch (e) { }
frontend/index.html:34918:        for (const l of C.btc.lines) try { C.btc.main.removePriceLine(l); } catch (e) { } C.btc.lines = []; S.walls = [];
frontend/index.html:34927:          try { C.btc.chart.timeScale().setVisibleLogicalRange({ from: N - show - 0.5, to: N + 3 }); } catch (e) { }
frontend/index.html:34939:        if (y == null || !G.ps) { box.innerHTML = ''; return; } const fmt = k === 'btc' ? f0(val) : k === 'vpi' ? Math.round(val) : f1(val) + (k
frontend/index.html:34988:        const lg = $('rgLg_btc'), TOP = lg ? lg.offsetTop + lg.offsetHeight + 6 : 64; const placed = []; for (const q of pills.sort((a, b) => a.
frontend/index.html:35009:        // BTC
frontend/index.html:35011:          const o = S.charts.btc, G = geo(o), X = i => G.ts.timeToCoordinate(tCh(B.px[i].t)); let h = '', lastL = -1e9;
frontend/index.html:35027:          clip('btc', h); const nV = visN(B), LV = B.px[nV - 1]; tag('btc', LV.c, LV.c >= LV.o ? up : dn, nV === N ? end : null);
frontend/index.html:35052:      function lanes(B) { const el = $('rgLanes'); if (el && !el.__b) { el.__b = 1; el.innerHTML = ['RV', 'IV', 'VoV', 'DVOL'].map((n, r) => `<e
frontend/index.html:35053:      /* v84 · "paid": realised vol of BTC over each candle (Parkinson on the hourly bars) ÷ the IV (1-day IV, DVOL standing in) at the candle
frontend/index.html:35079:        const h = `<span class="rg-paid" id="rgPaid" title="Candles this ${PU[S.view]} where BTC moved less than the recorded 1-day ATM IV paid 
frontend/index.html:35083:        const box = $('rgCells'); if (!box) return; const G = geo(S.charts.btc), IV = ivView(B), N = B.px.length; box.style.width = Math.max(0, 
frontend/index.html:35112:        setH('rgLg_btc', `<span class="rg-row"><b>BTC</b><span class="rg-s">Delta index</span><span class="rg-tf">${tf}</span><span>O <span clas
frontend/index.html:35132:      /* ---------- verdict bar (under BTC) + chip row (above the vol charts) ---------- */
frontend/index.html:35242:      /* alert / replay buttons on the BTC pane (drawing comes from the Desk's pen, bottom-right of every chart) */
frontend/index.html:35244:        const pane = document.querySelector('#regRoot .rp-btc'); if (!pane || pane.__tb) return; pane.__tb = 1; const d = document.createElement
frontend/index.html:35251:        if (!S.built) return; let L = []; try { L = (W.priceAlerts.list() || []).filter(a => a.tgt === 'btc'); } catch (e) { } const sig = L.map
frontend/index.html:35252:        const m = S.charts.btc.main; for (const l of alLines) try { m.removePriceLine(l); } catch (e) { } alLines = L.map(a => m.createPriceLine
frontend/index.html:35257:      W.Regime = { state: () => S, compute, render: () => render(true), load: loadAll, stateAt, VIEWS, btc: () => S.built ? { chart: S.charts.bt
frontend/index.html:35264:       speed = BTC realised vol (Parkinson on 1-m index bars; 5-m bars only if 1-m are missing)
frontend/index.html:35266:       1× is the only line: under 1× BTC moved less than the premium paid for (a short strangle earned),
frontend/index.html:35271:       UI: card on top of the Strangle Signal · speed lane under the BTC chart (green < 1×, red > 1×, session bands).
frontend/index.html:35345:      /* ---------- speed lane under the BTC chart ---------- */
frontend/index.html:35383:          h += `<i class="t-${cls}${q.live ? ' lv' : ''}${q.wk ? ' wk' : ''}${ov ? ' ov' : ''}" style="left:${q.x.toFixed(1)}px;width:${q.w.toFi
frontend/index.html:35450:       it lagged and flipped and told nothing the Tonight rail, slopes and Speed vs IV do not). ADX stays on the BTC chart.
frontend/index.html:35723:       ADX/ATR → chance BTC moves more than ONE expected move within 4 h
frontend/index.html:35843:        return `<span class="calc ${tone}" data-cal="adx" title="Chance BTC moves more than one expected move within ${hz}, in this ADX / ATR st
frontend/index.html:35850:        const K = C.adx; if (!K) return '<p class="cp-n">Waiting for BTC candles…</p>';
frontend/index.html:35854:        let h = `<div class="cp-big">${r ? `<b class="${r.r <= K.base.r * 0.85 ? 'g' : r.r >= K.base.r * 1.2 ? 'r' : ''}">${pc(r.r)}</b> chance 
frontend/index.html:35865:            if (n) h += `<p class="cp-s">Your strikes ${Math.round(pK).toLocaleString('en-US')} / ${Math.round(cK).toLocaleString('en-US')} sit 
frontend/index.html:36553:       v90 · Session leader — which session moves BTC lately
frontend/index.html:36554:       Share of each weekday's BTC movement (Parkinson variance of 5-min Delta index
frontend/index.html:36646:    /* v94 · Layered volatility candles on the Regime BTC chart.
frontend/index.html:36724:            // paid: IV at the start of this part − BTC realised during it (both annualised vol points)
frontend/index.html:36786:        const h = f('up', 'IV rose') + f('flat', 'flat') + f('dn', 'IV fell'); return h ? `<div class="ly-hist"><b>History · how often each par
frontend/index.html:36789:        curB = B; curV = view; curS = S; let box = $('rgLyBar'); const pane = D.querySelector('#regRoot .rp-btc'); if (!pane) return;
frontend/index.html:36797:        if (!subd) { try { const R = W.Regime.btc(); if (R && R.chart) { R.chart.subscribeCrosshairMove(p => { const t = p && p.time != null ? p
frontend/index.html:36801:      /* ---------- v95 · the same session layers on the Desk BTC chart ---------- */
frontend/index.html:37025:       DVOL mini charts with 1-h lines · BTC chart opening range and ±1 EM lines.
frontend/index.html:37058:      function btcBars(fromMs) { try { const R = W.rvIndexBars && W.rvIndexBars(); if (!R || !R.bars || !R.bars.size) return []; const out = [];
frontend/index.html:37154:          const B = btcBars(ny); const or = B.filter(b => b.t < ny + 30 * MIN);
frontend/index.html:37190:        const rows = stitched(pane); if (!rows) return null; const B = btcBars(now - 2 * DAY); if (B.length < 200) return null;
frontend/index.html:37331:      /* ---------------- BTC chart: opening range + ±1 EM ---------------- */
frontend/index.html:37341:      /* ---------------- BTC chart: day / week / month high-low LEVELS (5-yr backtest-tagged) ----------------
frontend/index.html:37458:        // Cluster and merge duplicates within 0.08% of price (~$50 on BTC)
frontend/index.html:37756:    /* desktop: the BTC chart block is one screen tall; panes share it instead of growing the page */
frontend/index.html:37810:       · Highest put / call open interest of the master expiry drawn on the BTC chart.
frontend/index.html:37918:      /* ================= highest OI on the BTC chart ================= */
frontend/index.html:37975:          const sym = String(p.product_symbol || (p.product && p.product.symbol) || p.symbol || ''), m = /^([CP])-BTC-(\d+(?:\.\d+)?)-(\d{2})(\d
frontend/index.html:38148:        return [{ k: 'rel', n: 'No US release inside the hold', why: 'CPI / FOMC / NFP lift BTC realised vol for 2–4 h after the print', hit: 
frontend/index.html:38824:      function expList() { let a = []; try { if (typeof expiryList !== 'undefined' && Array.isArray(expiryList)) a = expiryList.slice(); } catch
frontend/index.html:38892:      /* ---------------- 5-minute BTC bars: range and realised vol ---------------- */
frontend/index.html:38930:        const L = liveDecision(), R = dvolRank(), t = { k: 'prem', n: 'Premium', st: 'na', v: '—', u: '', s: 'waiting for IV and BTC history',
frontend/index.html:38933:          t.act = t.st === 'wn' ? 'edge under +3: thin, size down' : t.st === 'bad' ? 'IV is below the move BTC is expected to make' : ''; t.L =
frontend/index.html:38960:          t.act = `${nm} printed ${dur(now - past.t)} ago: BTC usually keeps moving more than normal for about ${Math.round(evDur(past) / HR)} h
frontend/index.html:39025:        const B = bars(), t = { k: 'range', n: 'Range', st: 'na', v: '—', u: '', s: 'waiting for BTC 5-minute history…', a: '', src: 'r', ac
frontend/index.html:39029:        t.act = x > 1.5 ? 'BTC already moved more than 1.5× the expected day: a trend is running' : x > 1 ? 'range above one expected move: exp
frontend/index.html:39035:         many of the last 20 weekday Asia sessions fell at least that far from their open (5-minute BTC index), plus the crowding
frontend/index.html:39112:  <p><b>Leading</b> means it is priced or positioned before BTC moves: what you are paid against the move expected (Premium), which day the opti
frontend/index.html:39121:          const L = t.L, R = t.R; return head + `<p><b>What it is.</b> The IV you can sell at (bid when recorded) minus the volatility BTC is ex
frontend/index.html:39122:    <ul><li>${L ? `Sell at <b>${f1(L.iv)}</b> (${L.isBid ? 'bid' : 'mark, no bid recorded yet'}) · expected realised <b>${f1(L.exp)}</b> · edg
frontend/index.html:39163:    <ul>${w ? `<li>${f0(w.pk.K)} put (${w.pk.d.toFixed(2)}Δ) + ${f0(w.ck.K)} call (${w.ck.d.toFixed(2)}Δ)${w.fromPlan ? ', the plan strikes' :
frontend/index.html:39168:          return head + `<p><b>What it is.</b> How far your put (or the plan's put) sits from spot in Asia-session expected moves (master-expiry
frontend/index.html:39175:          return head + `<p><b>What it is.</b> How far BTC travelled from its price 24 hours ago, measured in expected 1-day moves (DVOL ÷ √3
frontend/index.html:39200:        const html = `<div class="l4-box"><div class="l4-h"><h2>Leading signals</h2><span class="s">what is priced and positioned <b>before</b> 
frontend/index.html:39564:    /* indicator panes under the BTC chart */
frontend/index.html:40499:    /* v105.14 · repeated chart options skipped; BTC chart no longer re-animated to live every 1.5 s; Edge kept per master expiry (instant swit
frontend/index.html:40654:       v105 (12 Oct 2026) · Edge and Range candles under the BTC chart
frontend/index.html:40661:       · RANGE = BTC's largest move away from the price 24 h earlier ÷ the expected day move
frontend/index.html:40664:       Panes are separate charts scrolled, zoomed and crosshaired with the BTC chart (as ADX).
frontend/index.html:40768:      /* ---------------- the BTC chart's own bars ----------------
frontend/index.html:40769:         The panes carry exactly the BTC series' items (same count, same times, whitespace included), so a logical
frontend/index.html:40770:         range means the same candles on every chart. Rebuilt the moment the BTC data changes (history stage, new bar,
frontend/index.html:40779:      /* ---------------- candles on the BTC chart's bars ---------------- */
frontend/index.html:40812:              `<span class="dim">largest BTC move from 24 h ago ÷ the day move DVOL priced</span>`;
frontend/index.html:40917:        if (!Dd) { P.leg.innerHTML = `<b>${P.name.toUpperCase()}</b><span class="dim">waiting for BTC candles…</span>`; return; }
frontend/index.html:40920:        if (!fin(v)) { P.leg.innerHTML = `<b>${P.name.toUpperCase()}</b><span class="dim">${(() => { const L5 = fiveBars(); if (!L5 || L5.bars.s
frontend/index.html:41012:      /* v116 · alignment guard. The panes follow the BTC chart by bar number (logical range). When the BTC chart's bar list changes
frontend/index.html:41016:         BTC chart's current bars and snapped back to the same window. */
frontend/index.html:41030:        { let n = 0; const early = setInterval(() => { tick(); if (++n >= 20 || (PANES.edge.data && PANES.rng.data)) clearInterval(early); }, 50
frontend/index.html:41033:        // a timeframe / range change gives the BTC chart new bars: extend the edge grid back to its first bar at once
frontend/index.html:41128:      /* ---------------- BTC overlay: 3D gamma levels (γ flip, call wall, put wall) ----------------
frontend/index.html:41131:      function btcLv() {
frontend/index.html:41146:      function schedBtcLv() { if (!braf) braf = requestAnimationFrame(btcLv); }
frontend/index.html:41221:      // full screen / replay need every chart: never hide while the BTC chart is full screen
frontend/index.html:41342:    /* 4. BTC chart: γ flip / call wall / put wall names were written twice — at the left edge, on top of the candles and the
frontend/index.html:42036:      /* ---------------- Black-Scholes (per 1 BTC of underlying) ---------------- */
frontend/index.html:42079:          const sym = String(p.product_symbol || (p.product && p.product.symbol) || p.symbol || ''), m = /^([CP])-BTC-(\d+(?:\.\d+)?)-(\d{2})(\d
frontend/index.html:42119:         Delta's own history: each leg's 15-minute mark candles and the BTC index, IV implied from each mark (Black-Scholes), the same
frontend/index.html:42167:      // BTC level at which a leg is worth 2× what it was sold for, at its live IV and the time left now
frontend/index.html:42181:      // realised vol of the BTC index over the last h hours, from the desk's 1-minute bars (annualised, %)
frontend/index.html:42204:        g += `<line x1="${X(S).toFixed(1)}" x2="${X(S).toFixed(1)}" y1="4" y2="${H - 18}" stroke="var(--text)" stroke-width="1.4"/><text x="${(X
frontend/index.html:42212:          return `<div class="v28lr"><div class="a"><b>${l.type === 'P' ? 'Put' : 'Call'} ${kf(l.K)}</b><i>${l.n} lot${l.n === 1 ? '' : 's'} · 
frontend/index.html:42215:      <div><small>Leg stop 2×</small><b>${fin(l.entry) ? px(2 * l.entry) : '—'}</b><i class="${d != null && Math.abs(d) < 0.015 ? 'neg' : ''}
frontend/index.html:42224:    <span><small>Gamma</small><b class="neg">${usd(g.gam1, true)}</b><i>on a 1% BTC move · ${hrs(g.gam1)}</i></span>
frontend/index.html:42225:    <span><small>Delta</small><b>${usd(g.del1, true)}</b><i>if BTC +1% now</i></span></div>
frontend/index.html:42226:    <div class="v28cov ${cov == null ? '' : cov >= 1.15 ? 'ok' : cov >= 0.9 ? 'mid' : 'bad'}">${label || 'Theta pays for'} BTC moves up to <b>${
frontend/index.html:42350:        if (worst && (!best || -worst.v >= best.v * 0.5)) { const s = worst.k === 'iv' ? 'IV rose' : worst.k === 'delta' ? 'BTC moved toward a l
frontend/index.html:42351:        if (best) return `<b>Main driver: ${best.k === 'time' ? 'time is paying' : best.k === 'iv' ? 'IV is falling' : best.k === 'delta' ? 'BTC
frontend/index.html:42388:    <div class="v28kp"><div><small>Entry</small><b>${dt(c.openedAt)}</b></div><div><small>Planned exit</small><b>${dt(xa)}</b></div><div><small>
frontend/index.html:42393:    <div class="v18why">${PO.be.length ? 'Breakevens at expiry ' + PO.be.map(kf).join(' / ') + '. ' : ''}${near ? `<b>Nearest leg stop: ${near.t
frontend/index.html:42446:        return `<div class="v18c v18"><div class="v18h"><h3>Entry check</h3><span class="r">${esc(day(settle(d.e)))} · 0.12Δ strangle · per 1
frontend/index.html:42447:    <p class="s" style="margin:4px 0 8px">No strangle open. What the premium carries if you sell the 0.12-delta put and call on the master expir
frontend/index.html:42449:      <div><small>Credit</small><b>${px(cr)}</b><i>per BTC</i></div><div><small>Expected move</small><b>±${(em * 100).toFixed(1)}%</b><i>to exp
frontend/index.html:42526:        const T2 = [['trade', 'exp', 'opened', 'closed', 'hold_min', 'exit_reason', 'pnl_usd', 'pct_of_premium', 'credit_usd', 'pnl_time', 'pnl_
frontend/index.html:42765:    <p class="s">Needs a <b>separate</b> API key with <b>Trade</b> permission, whitelisted for this server's address like your read key. <b>This
frontend/index.html:43217:      /* the BTC candles get the room: Edge and Range panes are shorter on desktop (they were 160 px each) */
frontend/index.html:43416:  <script id="v105_24Edge">/* v105.24 · live-edge guard for the BTC chart (and the panes that follow it).
frontend/index.html:45076:       (N2N 0.15Δ, 2× leg stop, NY entries; 1 yr hourly IV + 29 days of 1-min BTC):
frontend/index.html:45085:       Every input is computed here from candles[N2N] (Delta 1-min ATM IV), rvIndexBars (BTC 1-min), v105 Edge / Range,
frontend/index.html:45131:      /* ---------- BTC: RV and Speed vs IV ---------- */
frontend/index.html:45132:      function btcCloses(now, mins) {
frontend/index.html:45166:        const cl = btcCloses(now, 7 * 60 + 10); if (cl && R.iv) {
frontend/index.html:45225:        else if (R.speed != null && R.speed >= K.spd) { v = 'WAIT · BTC fast (Speed ' + R.speed.toFixed(1) + '× ≥ 1.5×)'; cls = 'a'; }
frontend/index.html:45732:    /* v123 · Clean charts (16 Oct 2026, preview, not deployed). Session boxes only on BTC and Range (the one box state that tested
frontend/index.html:45733:       useful: Range inside its London box in NY → BTC reached 1× EM 50 % vs 81 %); IV keeps the NY open line, first-hour shade, NY high
frontend/index.html:46006:       Plan: day & news, entry window, size, delta per leg, IV range, leg tilt (put lighter on news nights, when BTC fell
frontend/index.html:46007:         12:30→19:00, or IV under 28), approximate strikes and credit from BTC and N2N IV (check the chain before selling).
frontend/index.html:46009:         (suraj_archive_v1: 1-min IV per expiry, 1-min BTC). Engine = the backtest: v121 readings at each 15-m close, Black-Scholes
frontend/index.html:46056:      function btcSeries(recs, days, from, to) {
frontend/index.html:46103:        const db = await idb(); const bk = new Set(await keys(db, 'btc')), ik = await keys(db, 'iv'); const ivk = new Set(ik.map(String));
frontend/index.html:46108:          const iv = await getMany(db, 'iv', need), bt = await getMany(db, 'btc', [d, n1]);
frontend/index.html:46110:          const { cl, H } = btcSeries(bt, [d, n1], d0(d) + 6 * HR, d0(d) + 41 * HR); if (s.filter(p => p[0] >= F.open && p[0] <= F.exit).length 
frontend/index.html:46202:        rows.push({ k: 'tilt', name: 'Leg tilt', rule: 'Put lighter on news nights, after BTC fell 12:30→19:00, or IV under 28', live: tn.leng
frontend/index.html:46239:        const low = R.iv != null && R.iv < 28, on = news || fell || low; const why = [news ? 'news night' : '', fell ? 'BTC fell 12:30→19:00' 
frontend/index.html:46252:        T.push(['LEG TILT', t.on ? 'Put lighter' : 'Equal legs', t.on ? t.why : 'BTC rose into NY, no news', t.on ? 'a' : 'g']);
frontend/index.html:46257:            strikes = `<span>Call <b>${Math.round(Kc / 200) * 200}</b> · ${dC.toFixed(2)}Δ · ≈$${Math.round(c)}</span><span>Put <b>${Math.r
frontend/index.html:46265:        if (!C || !C.rows) return `<details id="v126c"><summary>Rule check <span class="v6m">${busy ? esc(prog) : 'runs by itself after 07:05 IS
frontend/index.html:46271:        return `<details id="v126c"${LSg('v126_open', 0) ? ' open' : ''}><summary>Rule check <span class="v6m">${busy ? esc(prog) : 'last run ' 
frontend/index.html:46335:    /* v127 · Option A: indicator tabs under the BTC chart (one open) + vol-chart picker (IV / RV / VoV / DVOL) */
frontend/index.html:46453:       "ƒx Indicators" in the BTC chart bar opens a list with search: Speed vs IV · Edge · Range · ADX · ATM IV · RV · VoV ·
frontend/index.html:46455:       Speed / Edge / Range / ADX sit under the BTC chart (heights shared out); IV / RV / VoV / DVOL follow straight below the BTC
frontend/index.html:46460:      const LIST = [['spd', 'Speed vs IV', 'RV ÷ IV bars · 1× and 1.5× lines', 'btc'], ['edge', 'Edge', 'IV − expected RV · above +3 = to
frontend/index.html:46461:      ['adx', 'ADX 14', 'trend strength · +DI / −DI', 'btc'], ['iv', 'ATM IV', 'candles of the chosen expiry · SELL zone · Friday path', 'v
frontend/index.html:46462:      ['vov', 'Vol of vol (VoV)', 'turned down ✓ / spiking', 'vol'], ['dv', 'DVOL', 'Deribit 30-day index · pre-NY band', 'vol'], ['ton', 'To
frontend/index.html:46463:      ['gex', 'Dealer gamma', 'γ flip · call / put walls · flows line · profile on the BTC chart', 'btc'],
frontend/index.html:46464:      ['term', 'Term spread', 'Current − N2N · Next − N2N · forward vol · tested: Current above N2N → IV fell 85%', 'btc'], ['skew', '2
frontend/index.html:46465:      ['fund', 'Funding + OI', 'Delta perp funding (a year) + open interest · crowding gauge', 'btc'], ['liq', 'Liquidations', 'OKX BTC swaps, 
frontend/index.html:46466:      ['strk', 'Strikes + expected move', 'your strangle (or tonight\'s suggested) strikes and the ±1σ band to expiry on the BTC chart', 'btc'
frontend/index.html:46467:      ['lvl', 'Levels · day/week/month', 'day · week · month high-low lines on the BTC chart · week/month LOW = ⬇ danger (red), HIGH = ⬆
frontend/index.html:46468:      ['sig', 'Entry signals', 'tested N2N playbook · SELL / EXIT marks on the BTC chart', 'btc'], ['pat', 'Chart patterns', 'head & shoulders 
frontend/index.html:46469:      ['risk', 'Entry Gauge (WAIT ↔ GO)', 'one RSI-style line: red and high until your checks agree for a short strangle, yellow while some ag
frontend/index.html:46470:      ['macro', 'Macro Stress (0–100)', 'Outside market pressure (forex, commodities, equities, yields, events) · sub-lane under chart', 'btc
frontend/index.html:46471:      ['rsi', 'RSI 14 + divergence', 'regular and hidden divergence on the BTC bars', 'btc'], ['dfl', 'Deribit option flow', 'net puts / calls b
frontend/index.html:46472:      ['grk', 'ATM Greeks', 'Θ · Vega · Γ · Δ of the master expiry (follows it) · plus your strangle', 'btc'], ['spr', 'Bid / ask spread'
frontend/index.html:46473:      ['fp', 'Footprint', 'sell × buy volume per price inside each candle · zoom in', 'btc'], ['vwap', 'VWAP ± bands', 'session VWAP (05:30 I
frontend/index.html:46474:      ['avp', 'Anchored VWAP + volume', 'from the NY open or a candle you pick · volume profile, POC, value area', 'btc'], ['lhm', 'Liquidation
frontend/index.html:46475:      ['ses', 'Session boxes + IV', 'Asia · London · New York boxes on the BTC chart, each labelled with its IV change · green = IV fell, red
frontend/index.html:46476:      ['crush', 'IV driver · crush', 'who moves IV: put wing vs call wing (25Δ) per candle + Deribit flow · puts lifting IV = put-leg danger'
frontend/index.html:46604:    /* v128 · bigger panels: vol charts one per row under the BTC block; zoom − + fit on every chart */
frontend/index.html:46701:       Edge / Range / ADX / Speed follow the BTC chart, so their buttons zoom the BTC chart. Vol charts open fitted like the BTC
frontend/index.html:46736:            /* the BTC chart leads Edge/Range/ADX/Speed; the IV chart leads RV/VoV/DVOL of its pane (they follow it) */
frontend/index.html:46788:    /* v130 · one full screen. Both buttons (header ⛶ and "Full screen" in the BTC chart head) now do the same thing: the
frontend/index.html:46789:       browser goes full screen and the desk shows the BTC chart platform only (ticker and header stay); Esc or the button
frontend/index.html:47466:       · Near-black dark theme by default (new key btc_atm_iv_theme_v132; the theme switch still works).
frontend/index.html:47467:       · Master expiry (Cur · Next · N2N, Auto) moved into the BTC chart bar beside the timeframes.
frontend/index.html:47656:       1. Clean first screen without full screen: the Trade page is the chart platform only and fits the window — BTC chart + the
frontend/index.html:47659:          positioning panels are off the Trade page. Dealer gamma and Tonight are items in the Indicators menu. BTC chart layers
frontend/index.html:47663:          expired contracts settled at the Delta BTC index at 17:30 IST) → one row per expiry (strangle), call vs put legs. */
frontend/index.html:47673:           lane); the indicator lanes share at most ~40 % of it and get shorter as more are switched on, the BTC candles
frontend/index.html:47684:        // vol charts first: each gets a fixed, readable strip; the BTC block takes what is left
frontend/index.html:47722:      const parseSym = s => { const m = /^([CP])-BTC-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/i.exec(String(s || '')); return m ? { type: m[1].toU
frontend/index.html:47798:   <p class="src" style="margin:0">From your Delta fills (signed, read-only). Each contract: sells − buys − commission; a contract held to e
frontend/index.html:47846:       3. Entry signals on the BTC chart: the tested N2N playbook, replayed on every completed 15-min bar of the last 4 nights
frontend/index.html:47850:          Needs the N2N IV history of that night (Delta backfill) and BTC 1-min bars; nights without them get no marks.
frontend/index.html:47855:      /* ---------- BTC hourly bars and ADX 14 ---------- */
frontend/index.html:47914:      /* ---------- markers for the BTC chart (called by the price-action layer) ---------- */
frontend/index.html:48240:      const PNL = { 1: [1.7, 50], 2: [3.1, 47], 3: [11.9, 47], 4: [-15.2, 83], 5: [21.0, 49] };   // v140: 1-year priced test (240 nights, Bitst
frontend/index.html:48415:    <span class="s">IV only (BTC moves are not in the grade). Live verdict on the board below still decides the entry.</span></div>`;
frontend/index.html:48443:      ${T(2, 'SPEED VS IV', sp != null ? sp.toFixed(2) + '×' : '—', 'Below 1.5× = BTC calm', sp == null ? '' : sp < 1.5 ? 'g' : 'r')}
frontend/index.html:48455:      <span class="s">BTC-priced test: only 4 Fridays · low confidence</span></div></div>`;
frontend/index.html:48664:    /* v137 (16 Oct 2026, preview, not deployed). New indicators in the ƒx menu, as lanes under the BTC chart (same bars, move
frontend/index.html:48665:       with the BTC chart):
frontend/index.html:48669:       - Funding + OI: Delta BTCUSD perp funding (annualised) as bars, open interest as a line.
frontend/index.html:48670:       - Liquidations: OKX BTC swaps (USD + USDT margined), last 15 min, longs / shorts — a badge on the BTC chart header.
frontend/index.html:48715:        try { const j = await getJ(`${API}/v2/history/candles?symbol=FUNDING%3ABTCUSD&resolution=1h&start=${st}&end=${now}`); S.fund = ((j && j.
frontend/index.html:48716:        try { const j = await getJ(`${API}/v2/history/candles?symbol=OI%3ABTCUSD&resolution=1h&start=${st}&end=${now}`); S.oi = ((j && j.result)
frontend/index.html:48720:      /* ---------- liquidations (OKX public, BTC swaps) ---------- */
frontend/index.html:48723:        for (const [uly, usd] of [['BTC-USD', (sz) => sz * 100], ['BTC-USDT', (sz, px) => sz * 0.01 * px]]) {
frontend/index.html:48740:        if (b.textContent !== t) b.textContent = t; b.className = tot >= 25e6 ? 'hot' : tot >= 5e6 ? 'warm' : ''; b.title = 'Liquidations on OKX
frontend/index.html:48844:    /* v138 · ONE chart panel: BTC on top, every ticked indicator a section of the same panel (CoinGlass style) */
frontend/index.html:49249:       BTC is the primary chart; every indicator ticked in ƒx Indicators is a SECTION of the same panel under it: thin divider,
frontend/index.html:49252:       - IV / RV / VoV / DVOL are now sections built on the BTC chart's own bars (same bar = same time), so they can never
frontend/index.html:49253:         drift from the BTC chart. The old separate vol cards are hidden in this mode.
frontend/index.html:49260:         expected-move band to the N2N expiry on the BTC chart; Leg multiple section while a trade is open (call ×, put ×,
frontend/index.html:49277:      /* ---------- the BTC bars ---------- */
frontend/index.html:49520:          const bar = B.b[i], rows = [['BTC', bar.close != null ? bar.close.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—']];
frontend/index.html:49551:      /* ---------- strikes + expected-move band on the BTC chart ---------- */
frontend/index.html:49594:      /* ---------- v138.1: per-section zoom (roller + wheel/drag like the BTC chart, time stays shared) ---------- */
frontend/index.html:49598:        // ate over half the height and squashed the candles, so it is capped at 8 px and the data fills the lane like BTC
frontend/index.html:49647:        // tested entry / exit marks (same as on the BTC chart)
frontend/index.html:49984:      const GROUPS = [['n', 'NEW IN v142 · tick to show', ['rsi', 'dfl', 'grk', 'spr', 'fp', 'vwap', 'avp', 'lhm']], ['e', 'ENTRY · TRUSTED (1
frontend/index.html:50007:          const r = await fetch(`${API}/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=BTC&expiry_date=${d}-${m}-${
frontend/index.html:50082:      ${be != null ? `<div class="note ${ahead === false ? 'r' : 'g'}">Theta of the strangle pays for BTC moves up to <b>${be.toFixed(2)}% an ho
frontend/index.html:50083:      <span class="s">${esc(CH.e)} · switches with Cur / Next / N2N · per 1 BTC · Delta marks</span>`;
frontend/index.html:50127:    ${window.__STRANGLE_IMPULSE ? (() => { const IM = window.__STRANGLE_IMPULSE, rp = IM.replay || [], first = rp.find(x => x.r >= 1.5), peak = 
frontend/index.html:50138:      const verdict = r => !r || !r.n ? 'no sessions at this IV in the year of data' : r.n < 15 ? 'only ' + r.n + ' sessions, too few to trust' 
frontend/index.html:50139:      return `<table><thead><tr><th>ATM IV at entry (your 1-year dataset, ${T.length} trades)</th><th>stopped</th><th>win</th><th>avg P&amp;L pe
frontend/index.html:50140:      <span class="s"><b>ATM IV today:</b> ${iv != null ? iv.toFixed(1) + '%' : 'not read yet'}${pctl != null ? ' (' + (100 - pctl) + '% of your
frontend/index.html:50141:    ${(() => { const SS = W.v153 && W.v153.status ? W.v153.status() : null; if (!SS) return ''; const f = c => { const o = SS.live[c], b = SS.bl
frontend/index.html:50143:      return `<table><thead><tr><th>After entry: BTC moved 0.9% one way within 8 h</th><th>hours</th><th>either side</th><th>up</th><th>down</th
frontend/index.html:50144:      <table><thead><tr><th>Out-of-sample: BTC moved this far one way within…</th><th>all</th><th>red</th><th>yellow</th><th>green</th><th>ski
frontend/index.html:50151:      const log = F.open ? `<div style="max-height:340px;overflow:auto"><table><thead><tr><th>Night</th><th>Gauge at 22:30</th><th>BTC biggest m
frontend/index.html:50152:      return `<span class="s"><b>HOW TO READ THE TABLES BELOW.</b> Every row is one night where you sell a strangle at 22:30 IST and hold to abo
frontend/index.html:50153:      <table><thead><tr><th>Which day is safest? (5 years)</th><th>Nights</th><th>Stopped</th><th>BTC moved 0.9%+</th><th>Gauge was GREEN</th></
frontend/index.html:50154:      <span class="s"><b>In plain words:</b> ${FULL[best.name]} was the safest night (stopped ${best.stop}% of the time) and ${FULL[worst.name]}
frontend/index.html:50155:      <table><thead><tr><th>What IV did overnight</th><th>Nights</th><th>BTC moved 0.9%+</th><th>Stopped</th></tr></thead><tbody><tr><td class="
frontend/index.html:50156:      <span class="s"><b>In plain words:</b> on ${Math.round(flat.n / DY.rows.length * 100)} nights in 100 IV barely moved and the strangle was 
frontend/index.html:50157:      <table><thead><tr><th>Gauge colour at 22:30</th><th>Nights</th><th>Stopped</th><th>BTC moved 0.9%+</th><th>IV up 2+</th><th>IV down 2+</th
frontend/index.html:50158:      <table><thead><tr><th>Year</th><th>Nights</th><th>Stopped</th><th>BTC moved 0.9%+</th><th>IV up 2+</th><th>IV down 2+</th></tr></thead><tb
frontend/index.html:50159:      <details id="v155daily"${F.open ? ' open' : ''}><summary><b>Day-by-day list, 5 years (${DY.rows.length} nights): tap to open</b></summary>
frontend/index.html:50288:    /* repair: no countdown in the Edge / Range / ADX axes (the BTC chart keeps its countdown) */
frontend/index.html:50499:    /* both themes: the "BTC · Full screen" row above the chart is empty on phones and repeats the header's full-screen button */
frontend/index.html:50724:      /* IMPULSE WATCH: the desk's impulse meter (BTC speed over 5 minutes against normal for this hour, minute by minute) plus a string of big 
frontend/index.html:50750:        if (I.st >= 3) { out.level = 3; out.text = 'IMPULSE: BTC is moving ' + I.r.toFixed(1) + '× faster than normal' + (way ? ', ' + way : ''
frontend/index.html:50751:        else if (I.st === 2) { out.level = 2; out.text = 'FAST: BTC is moving ' + I.r.toFixed(1) + '× faster than normal' + (way ? ', ' + way :
frontend/index.html:50755:        if (!out.level && !I.gate) { out.level = 1; out.text = 'GATE SHUT: BTC was fast ' + (I.wait ? 'under ' + I.wait + ' min ago' : 'minutes 
frontend/index.html:50808:        row.innerHTML = '<span>MY LAYOUTS</span><button type="button" data-chart title="Only the BTC chart">Chart only</button>' +
frontend/index.html:50867:      /* impulse watch: checked every 4 s, so a fast BTC move reaches you in seconds (the hourly gauge cannot) */
frontend/index.html:50876:            const lvl = I.level >= 3 ? 'danger' : 'bad', ttl = holding ? 'BTC IS MOVING FAST while you are short' : 'BTC is moving fast: entry g
frontend/index.html:50889:       - at every entry hour it stores the gauge's checks; 8 hours later it replays the same short strangle on the BTC bars it has seen (0.15Δ 
frontend/index.html:50978:    /* v154 (24 Oct 2026) · keep the newest candle in the middle area. The BTC chart and every lane under it (they follow its time range) show 
frontend/index.html:51079:        const chips = [[win[0], win[1]], wdRow ? [FULL[nowWd] + ': ' + wdRow.stop + '% stopped', wdRow.stop <= 20 ? GR : wdRow.stop >= 28 ? RD :
frontend/index.html:51093:        ${mvBars ? `<div class="vc"><div class="vt">BTC moved 0.9% within the first hour</div>${mvBars}<div class="vcap">Share of entries follow
frontend/index.html:51095:        ${ivBars ? `<div class="vc"><div class="vt">What IV did overnight (stopped %)</div>${ivBars}<div class="vcap">A big IV jump up or down w
frontend/index.html:51096:        ${rangeBars ? `<div class="vc"><div class="vt">Your ATM IV range (stopped %, your 1 year)</div>${rangeBars}<div class="vcap">${iv != nul
frontend/index.html:51214:          ['02:30', 'Hold and watch the alerts', 'Red gauge, fast BTC or a news event: check your legs, not just the number.'],
frontend/index.html:51255:        if (pr) past = `<div class="cap"><b>What happened that night (5-year model):</b> gauge ${({ g: 'GREEN', y: 'YELLOW', r: 'RED' })[pr[2]]}
frontend/index.html:51259:          ${st ? `<div class="tiles">${mini(st.stop, st.stop <= 20 ? GR : st.stop >= 28 ? RD : AM, 'stopped (5 yrs)')}${mini(st.big09, GY, 'BTC 
frontend/index.html:51494:        const bandRow = (() => { if (d.iv == null) return `<div class="r"><div class="t">Today's IV band</div><div class="cap">ATM IV not read y
frontend/index.html:51570:      const COINS = [['BTC', 'BTCUSDT'], ['ETH', 'ETHUSDT'], ['BNB', 'BNBUSDT'], ['SOL', 'SOLUSDT'], ['XRP', 'XRPUSDT'], ['DOGE', 'DOGEUSDT'], [
frontend/index.html:51717:    /* v163 (24 Oct 2026) · opens in full screen, and the phone chrome is smaller so the BTC chart gets the room.
frontend/index.html:51829:         - Theta: what one hour, and the time to 07:00 IST, earns you with BTC and IV unchanged.
frontend/index.html:51831:         - Delta + gamma: what a 0.9 % BTC move against you does to the price, split into the straight-line part (delta) and the curve part (gam
frontend/index.html:51832:         - Bad-night shock = BTC 0.9 % against + IV up 3 points: the dollars from delta, gamma and vega, and which one drives the loss.
frontend/index.html:51833:         - Stop distance: the BTC move that takes the leg to the stop (2x the sell price) with IV unchanged, and the chance BTC touches it befor
frontend/index.html:51905:      /* BTC move (as a fraction, against the seller) that takes the price to `target` with IV and time unchanged; null if not reached within 15
frontend/index.html:51974:          const r = await fetch('https://api.india.delta.exchange/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=BT
frontend/index.html:52028:        const dom = (() => { const o = [['BTC move, straight line (delta)', sp(c.dPart)], ['BTC move, curve (gamma)', sp(c.gPart)], ['IV rise (v
frontend/index.html:52033:          <div class="row"><span>Delta + gamma</span><b>BTC 0.9% against you: ${sgn(c.dPart)} from delta, ${sgn(c.gPart)} from gamma</b></div>
frontend/index.html:52034:          <div class="row"><span>Bad night</span><b>BTC 0.9% against + IV +3 pts: price ${$$(c.mark)} → ${$$(newPx)} (${x.toFixed(2)}×)</b></
frontend/index.html:52037:          <div class="row"><span>Stop at 2× (${$$(c.stopPx)})</span><b>BTC ${c.stopMove == null ? '>15%' : (c.call ? '+' : '−') + (c.stopMove
frontend/index.html:52050:        let h = `<div class="hd"><div class="t"><span>Strike picker · delta 0.10 to 0.15</span><button type="button" aria-label="Close" data-v1
frontend/index.html:52056:          if (d.pnl) h += `<div class="why">${d.pnl.lots} lots: expected P&amp;L at 07:00 ${d.pnl.exp >= 0 ? '+' : '−'}$${Math.abs(d.pnl.exp).
frontend/index.html:52058:          h += `<div class="note">The pick is the pair of strikes in the 0.10–0.15 band with the best premium × (1 − 2 × touch chance), lo
frontend/index.html:52095:        else if (!ivOk || pBoth > 0.3 || minStop < 0.012 || gapBad) { col = AMBER; t = 'CAUTION'; sub = gapBad ? 'No call and put within 0.03 of
frontend/index.html:52114:        return `<div class="pl"><div class="hd2"><div><div class="num" style="color:${col}">${money(q.exp)}</div><div class="sub">expected P&amp
frontend/index.html:52116:          <svg viewBox="0 0 ${W2} ${H2}" style="margin-top:6px"><line x1="0" x2="${W2}" y1="${mid}" y2="${mid}" stroke="#8888"/>${bars}<line x1=
frontend/index.html:52117:          <div class="tiles"><div><b style="color:${q.flat >= 0 ? GREEN : REDC}">${money(q.flat)}</b><span>BTC flat</span></div><div><b style="c
frontend/index.html:52125:        h += `<div class="note">Dashed red = a 0.9% BTC move. A dot left of it means that move alone stops the leg. Switch to Details for the nu
frontend/index.html:52265:    /* v170 (24 Oct 2026) · phone chart toolbar: the full timeframe row (1m … 1D) and the "BTC" label are replaced by one "TF · 5m" chip nex
frontend/index.html:52325:       Sections under the BTC chart
frontend/index.html:52330:         rsi  RSI 14         on the BTC bars · regular divergence (Bull / Bear) and hidden divergence (H bull / H bear)
frontend/index.html:52332:         grk  ATM Greeks     of the master expiry (changes with it): Θ $/day, Vega $/vol pt, Γ per $1k, Δ — per 1 BTC
frontend/index.html:52335:       Overlays on the BTC chart
frontend/index.html:52393:        o.car = ch.addLineSeries({ color: 'rgba(0,0,0,0)', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisibl
frontend/index.html:52418:        if (k === 'pulse') {   // Strangle Pulse: risk lines on ONE right axis (0 calm = green sell zone at the bottom, 100 = red no-sell zone a
frontend/index.html:52499:      const KH = ['https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT', 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT', 'https://dat
frontend/index.html:52751:      /* ---------- Greeks of the ATM straddle (per 1 BTC), model on the desk's ATM IV ---------- */
frontend/index.html:52843:          // one value per chart bar, straight-joined between the 15-minute samples so every line is unbroken and sits on the BTC chart's own ti
frontend/index.html:52925:            `<span class="m">${esc(e || '')} straddle per 1 BTC${g ? ` · Θ $${f1(g.theta)} · Vega $${f1(g.vega)} · Γ ${f2(g.gamma)}` : ''}$
frontend/index.html:53988:       · Entry signals drawn on the BTC chart: SELL / EXIT / BOOK pills, the hold band with the entry price, and a live
frontend/index.html:54032:        adx: [5, 't', 'Sell only when 1-h ADX is <em>≤ 40 and lower than 3 h ago</em> (trend fading): +10.8 % of credit vs +7.0 % without it. 
frontend/index.html:54034:        sig: [7, 't', 'SELL / EXIT / BOOK pills drawn on the BTC chart from the tested playbook, with the hold band and entry price between them
frontend/index.html:54036:        spd: [9, 'c', 'RV ÷ IV: how fast BTC moves against what the premium prices. <em class="ok">Under 1× = good for sellers.</em> The teste
frontend/index.html:54038:        strk: [11, 'h', 'Your strikes (or tonight\'s suggested ones) and the ±1σ move to expiry on the BTC chart. Price walking toward a strik
frontend/index.html:54045:        rng: [17, 'w', 'BTC\'s 24-h move ÷ the day move DVOL priced. 1–2× is good. <em class="bad">Under 1× lost in every test</em> → ski
frontend/index.html:54107:      /* =================================================================== 3. entry / exit signals drawn on the BTC chart */
frontend/index.html:54167:        ['spd', 's', 'Speed vs IV back under 1.5×', 'BTC slows below 1.5× the premium after running above it'],
frontend/index.html:54173:        ['panic', 'x', 'Panic move', 'BTC moving 2× faster than the premium prices, or 1 % in 15 min'],
frontend/index.html:54190:        S.spd = { on: win && fin(R.speed) && (P('spd') ? R.speed < 1.5 : R.speed < 1.45), msg: () => ({ k: 's', g: '▼', grp: 'SUPPORTS THE SEL
frontend/index.html:54196:        const pnc = (fin(R.speed) && R.speed >= 2) || (m15 != null && Math.abs(m15) >= 1); S.panic = { on: pnc && (!!R.pos || win), msg: () => (
frontend/index.html:54205:        panic: { k: 'p', grp: 'PANIC · PROTECT', title: 'BTC moving fast', sub: 'down 1.15% in 15 min · speed 2.3× the premium', tiles: [{ n:
frontend/index.html:54369:            const [y, m, dd] = e.split('-'); const r = await fetch(`${API}/v2/tickers?contract_types=call_options,put_options&underlying_asset_s
frontend/index.html:54626:       Is a BTC move built on NEW positions or on positions CLOSING?  Binance BTCUSDT perp open interest (5-min,
frontend/index.html:54627:       in BTC so price changes don't fake OI growth) against the candle's direction:
frontend/index.html:54657:      const kRow = r => { const v = +r[5], b = +r[9]; return [+r[0], +r[1], +r[2], +r[3], +r[4], fin(v) && fin(b) ? 2 * b - v : 0]; };   // t,o,
frontend/index.html:54658:      async function oiPage(end) { const j = await getJ(`${FAPI}/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=500${end ? '&endTi
frontend/index.html:54659:      async function kPage(end) { const j = await getJ(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=1500${end ? '&endTime=' + end : 
frontend/index.html:54660:      async function okxOi() {   // fallback: OKX aggregate BTC contract OI (USD) → BTC with the kline close
frontend/index.html:54661:        const j = await getJ('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=5m'); const d = (j && j.data) 
frontend/index.html:54670:          try { if (!F.oi.length) { mergeOi(await oiPage()); F.src = 'Binance BTCUSDT perp'; } else mergeOi(await oiPage()); F.err = ''; }
frontend/index.html:54671:          catch (e) { if (!F.oi.length || F.src.startsWith('OKX')) { try { const o = await okxOi(); F.oi = []; mergeOi(o); F.src = 'OKX BTC swap
frontend/index.html:54686:          const [o, p] = await Promise.all([getJ(`${FAPI}/fapi/v1/openInterest?symbol=BTCUSDT`, 8000).catch(() => null), getJ(`${FAPI}/fapi/v1/p
frontend/index.html:54708:          r = await fetch(`https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-${day}.zip`, { cache: 'force-cache'
frontend/index.html:54734:            const j = await getJ(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=1500&startTime=${s0}`).catch(() => null); if (!Array.i
frontend/index.html:54834:        if (!F.oi.length || !F.k.length) { o.a.setData([]); o.b.setData([]); h.st(o, ''); h.setLeg(o, `<b>FUTURES</b><span class="m">${F.err ? '
frontend/index.html:54887:<p>Each bar is the change in <b>open interest</b> during the candle (${esc(F.src || 'Binance BTCUSDT perp')}, counted in BTC so a price move can
frontend/index.html:54888:${T && !T.short ? `<p class="s">Test: ${T.days} days of hourly data from ${new Date(T.from + IST).toISOString().slice(0, 10)}, weekday hours onl
frontend/index.html:54896:          if (b.dataset.x === 'csv') { const H = allHours(), txt = 'hour_utc,oi_btc_end,open,close,taker_delta_btc,oi_btc_start\n' + H.map(r => 
frontend/index.html:54915:       v146 · ALIGN — every pane under the BTC chart on the same time axis and the same price-axis width
frontend/index.html:54916:       Found by measuring each chart's x for the same candle against the BTC chart (desktop):
frontend/index.html:54917:         · ADX pane re-synced only when it was more than "near" the BTC range → sat ~0.8 bar to the left
frontend/index.html:54921:         · lower panes got the newest candle up to 15 s after the BTC chart
frontend/index.html:54922:         · ROOT CAUSE of the drift on phones: panes follow the BTC chart by slot number; any extra time slot on the BTC chart
frontend/index.html:54923:           (drawings, overlays, live points, grown history) shifted every pane. Each pane now mirrors the BTC chart's slots.
frontend/index.html:54946:      /* time-slot mirror: every pane gets the BTC chart's exact set of time slots as an invisible whitespace series. Panes are
frontend/index.html:54947:         synced by slot number (logical range); when the BTC chart carried slots a pane lacked (drawings, overlays, live points,
frontend/index.html:54970:        // newest candle: repaint the lower panes as soon as the BTC chart opens a new bar
frontend/index.html:55108:          // A PAST weekday with no backtest record = before the data window (BTC IV history starts 2021) → clear "no data".
frontend/index.html:55113:            r.why = D0 < Date.UTC(2021, 2, 24) - IST ? 'Before the backtest window — BTC implied-vol (DVOL) history only starts 2021. No model
frontend/index.html:56954:     Finance Minister Universe for BTC Short-Strangle Treasury Protection
frontend/index.html:57565:        // 3. INFLATION (BTC Rapid Rise - Threatens Call)
frontend/index.html:57571:          headline = 'INFLATION WARNING: BTC Rising Rapidly (Call Leg at Risk)';
frontend/index.html:57579:        // 4. CRISIS (BTC Rapid Fall - Threatens Put)
frontend/index.html:57585:          headline = 'CRISIS WARNING: BTC Falling Rapidly (Put Leg at Risk)';
frontend/index.html:58357:            '<b style="font-size:14px;color:#F8FAFC">🔍 SESSION INSPECTOR: ' + s.day + ' (' + s.dowName + ') · BTC @ $' + s.spot.toLocaleStri
frontend/index.html:58451:          '<th>BTC Spot</th>' +
frontend/index.html:58547:     Sits as a lane under the BTC chart and shares its time axis.
frontend/index.html:58931:  /* chart toolbar: BTC label shares the timeframe row, slimmer zoom rail; every px saved goes to the candles */
frontend/index.html:59008:/* v150 · week low / high pinned to the BTC chart edge when the candles' scale leaves them off screen */
frontend/index.html:59462:    const legs = (d.legs || []).map(l => '<tr><td>' + esc(l.symbol.replace(/-BTC/, '')) + ' <span class="dim">' + esc(l.side) + '</span></td><td
frontend/index.html:59469:      (d.spot && d.spot[i] != null ? tile('BTC', Number(d.spot[i]).toFixed(0), '', '') : '') +
frontend/index.html:59472:        : d.nowLegs && d.nowLegs.length ? '<div class="pcScroll"><table class="pcT"><thead><tr><th>Leg (now)</th><th>Entry</th><th>Mark</th><th>
frontend/index.html:60103:    future: f => { f.name = 'BTC perpetual'; f.instrument = 'future'; f.legs = []; f.exit.legStopMultiple = null; f.exit.futStopPct = null; f.ex
frontend/index.html:60177:    const legs = r.instrument === 'future' ? (r.future.side === 'long' ? 'Buy' : 'Sell') + ' ' + lots + ' lots BTC perpetual' : r.legs.map(l => 
frontend/index.html:60281:    ['change', 'Price change over time', 'How much BTC moved over the last N minutes, in percent. A small move supports selling options.'],
frontend/index.html:60282:    ['spot', 'Spot level', 'BTC price above or below a level you choose.'],
frontend/index.html:60352:    let h = '<div class="al-presets">Start from: ' + ['strangle', 'straddle', 'long', 'call', 'put', 'future'].map(k => '<button type="button" c
frontend/index.html:60355:      fld('Lots per leg', inp('lots', f.lots, { t: 'num', type: 'number' }), 'One lot is 0.001 BTC. Ask me "entry 50" uses 50.') +
frontend/index.html:60357:      fld('Instrument', sel('instrument', f.instrument, [['option', 'Options'], ['future', 'BTC futures']], { struct: 1 })) + '</div>';
frontend/index.html:60378:        fld('Stop loss ($ on the position)', inp('exit.futStopUsd', f.exit.futStopUsd, { t: 'nullnum', type: 'number', step: '1', ph: 'none' }),
frontend/index.html:60432:      const legs = r.instrument === 'future' ? 'BTC perpetual, ' + (r.future && r.future.side === 'short' ? 'sell' : 'buy') + ' ' + s.lots + ' l
frontend/index.html:60466:        (r.status === 'entered' && (r.liveLegs || []).length ? '<tr class="al-legrow"><td colspan="8">' + r.liveLegs.map(l => '<span class="al-l
frontend/index.html:60474:    h += Object.keys(groups).map(e => '<div class="al-row"><span>Delta · expiry ' + esc(e) + ' · ' + groups[e].map(d => esc(d.symbol.replace('
frontend/index.html:61020:    if (stops.length) meta.push(['Nearest stop', usd(Math.min(...stops)), 'per BTC price']);
frontend/index.html:61620:    if (S.testUntil > Date.now()) return [{ id: 'test', source: 'delta', label: 'TEST: this is only a test of the alarm', level: 'hard', since: 
frontend/index.html:61734:    const m = /^([CP])-BTC-(\d+)-(\d{2})(\d{2})(\d{2})$/.exec(symbol); if (!m) return symbol;
frontend/index.html:61752:      '<div id="ppLogin"></div><div id="ppNav"></div><div class="dk-pane" data-pane="over"><div id="ppPnl"></div><div class="dk-quick"><button t
frontend/index.html:61759:      '</div><div class="dk-pane" data-pane="fut"><div class="pp-card"><h3>Futures · BTC perpetual (BTCUSD)</h3><div id="ppFutQ" class="pp-perp
frontend/index.html:61762:      '<label>Size in lots (1 lot = 0.001 BTC) <span class="dim" id="ppFSize"></span><input type="number" id="ppFLots" min="1" step="1" value="1
frontend/index.html:61823:    ['Short straddle', 'Sell the call and put at the nearest strike: profits if BTC stays put.', (a) => [['sell', 'call', a, 1], ['sell', 'put',
frontend/index.html:61828:    ['Bull put spread', 'Sell a put, buy a lower put: a credit if BTC holds up.', (a) => [['sell', 'put', a - 1, 1], ['buy', 'put', a - 3, 1]]],
frontend/index.html:61829:    ['Bear call spread', 'Sell a call, buy a higher call: a credit if BTC stays below.', (a) => [['sell', 'call', a + 1, 1], ['buy', 'call', a +
frontend/index.html:61967:  /* option flow: what traders bought and sold (Deribit BTC options), by window, by strike and the biggest prints */
frontend/index.html:61972:  const btc = v => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
frontend/index.html:61979:    return 'bought <b>' + btc(x.buy) + '</b> / sold <b>' + btc(x.sell) + '</b> BTC <span class="' + (net >= 0 ? 'pos' : 'neg') + '">(' + (net >=
frontend/index.html:61986:    let t = '<div class="pp-note" style="margin:4px 0">What traders bought and sold in BTC options on Deribit (the biggest options venue), as of
frontend/index.html:61989:        '<tr><td>' + w.hours + ' h</td><td class="pos">' + btc(w.callBuy) + '</td><td class="neg">' + btc(w.callSell) + '</td><td class="pos">' 
frontend/index.html:61993:        const m = /^BTC-([0-9A-Z]+)-([0-9]+)-([CP])$/.exec(b.instrument) || [];
frontend/index.html:61994:        return new Date(b.at + 19800000).toISOString().slice(11, 16) + ' IST · ' + (b.direction === 'buy' ? 'bought ' : 'sold ') + btc(b.amount
frontend/index.html:62039:  /* ---------- futures: the BTC perpetual, margin = notional / leverage ---------- */
frontend/index.html:62040:  const PERP = 'BTCUSD';
frontend/index.html:62081:    const lots = Math.floor(Number(t.lots)) || 0; $('ppFSize').textContent = '= ' + (lots * 0.001).toFixed(3) + ' BTC';
frontend/index.html:62090:    h += pos.length ? pos.map(x => '<div class="pp-strat"><div class="pp-strat-top"><div><div class="pp-strat-name">' + (x.lots > 0 ? 'Long ' : 
frontend/index.html:62114:    if (g) h += '<div class="pp-sumgrid">' + cell('Net delta (BTC)', g.delta.toFixed(4)) + cell('Net gamma', g.gamma.toFixed(6)) + cell('Theta /
frontend/index.html:62380:    { id: 'howto_futures', guide: 'futures', p: [/future(s)? (trade|trading|paper)/, /(btc|bitcoin) future/, /perpetual/, /\bperp\b/], w: { futu
frontend/index.html:62432:    'How is margin calculated?', 'What is portfolio margin?', 'How does the stop loss work?', 'How do I set a stop?', 'How do I trade BTC future
frontend/index.html:62468:      { title: 'Open Delta India → Account → API keys', text: 'Create a new API key.', tip: 'Choose a clear name such as "BTC desk".' },
frontend/index.html:62494:    ], fix: [['"insufficient margin"', 'Reduce lots or switch margin mode; see "How is margin calculated?".'], ['A leg could not fill', 'The ord
frontend/index.html:62510:      { title: 'Portfolio margin (default)', text: 'All your options and futures are stressed together in price and volatility scenarios, so hed
frontend/index.html:62513:    ], fix: [['Different from Delta', 'It is an estimate calibrated to Delta\'s own figure; tell the owner the exact Delta number if it is off.'
frontend/index.html:62526:    futures: { title: 'Paper trade BTC futures', icon: 'bolt', intro: 'The BTC perpetual on your own paper account.', steps: [
frontend/index.html:62528:      { title: 'Set the size', text: '1 lot is 0.001 BTC. The card shows the position value and the estimated margin.' },
frontend/index.html:62600:      { t: 'tiles', items: [{ k: 'Nights studied', v: w.n }, { k: 'Legs stopped', v: num(w.stop) + '%', tone: tn }, { k: 'Average BTC move', v: 
frontend/index.html:62622:    const sub = iv == null ? 'Tell me an IV, e.g. "is IV 32 enough?"' : few ? 'too few past trades in this band to judge' : cur.cr < 250 ? 'thin
frontend/index.html:62624:    if (cur && !few) blocks.push({ t: 'tiles', items: [{ k: 'Past trades at this IV', v: cur.n }, { k: 'Stopped at 2x', v: num(cur.st, 0) + '%',
frontend/index.html:62626:    blocks.push({ t: 'bars', title: 'Average credit collected per BTC, by IV band', items: rows.map(r => ({ l: r.lo + '–' + r.hi, v: r.cr || 0
frontend/index.html:62638:      { t: 'bars', title: 'Total result by rule over 5 years (per BTC sold)', items: S.map(s => ({ l: s.name, v: s.total, tone: s === bigTot ? '
frontend/index.html:62788:    else if (p.legs === 'future') { r.instrument = 'future'; r.legs = []; r.future = { side: p.side || 'long' }; r.name = 'BTC perpetual ' + (p.
frontend/index.html:62848:    if (/^(?:please )?(?:(?:show|give|check|tell|open)(?: me)?\s+)?(?:what(?:'s| is| are)\s+)?(?:the\s+|my\s+)?(?:(?:current|today'?s?|btc|live|
frontend/index.html:62973:    if (!p.when && !p.entryTime && !p.window) { T.stage = 'when'; return msg('when', { lots: T.lots, what: p.legs === 'future' ? 'BTC future ' +
frontend/index.html:63092:      chart = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="BTC price, last 16 hours">' +
frontend/index.html:63171:      const head = '<div class="at-leg"><div class="at-legh"><b style="color:' + (l.type === 'call' ? '#15803D' : '#C53030') + '">' + (l.side ==
frontend/index.html:63177:      h += '<div class="at-lbl">Bad night (BTC 0.9% against, IV +3): what drives the loss</div>' + bar([[sp(c.dPart), '#C05621'], [sp(c.gPart), 
frontend/index.html:63312:      return '<div class="at-card"><div class="at-h">Lot size for ₹' + Number(m.capital).toLocaleString('en-IN') + '</div><div class="at-fine"
frontend/index.html:63650:      bits.push(r.instrument === 'future' ? 'BTC future ' + (r.future ? r.future.side : 'long') : r.legs.map(l => (l.side === 'sell' ? 'sell ' :
frontend/index.html:64671:  /** Parse contract symbol e.g. P-BTC-78800-011126 */
frontend/index.html:64684:    const m = sym.match(/^(C|P)-BTC-(d+)-(d{6})$/);
frontend/index.html:64688:        underlying: 'BTC',
frontend/index.html:65036:      deltaBtc: (netDelta * l * cv).toFixed(4) + ' BTC',
frontend/index.html:65151:   * Call C-BTC-83600-311026: Sold @ 135, Closed @ 98 -> +0.185 USD (+37 pts * 0.005)
frontend/index.html:65152:   * Put  P-BTC-78400-311026: Sold @ 134, Closed @ 102 -> +0.160 USD (+32 pts * 0.005)
frontend/index.html:65194:          callSym: closed[0].callSym || 'C-BTC-83600-311026',
frontend/index.html:65195:          putSym: closed[0].putSym || 'P-BTC-78400-311026',
frontend/index.html:65220:      callSym: 'C-BTC-83600-311026',
frontend/index.html:65221:      putSym: 'P-BTC-78400-311026',
frontend/index.html:65364:          '<div class="v-fpnl-row"><span style="color:#94a3b8;">Size:</span><strong id="vFpnlSize">5 lots (0.005 BTC)</strong></div>' +
frontend/index.html:65453:    if (sz) sz.textContent = (openPos.size || 5) + ' lots (' + ((openPos.size || 5) * 0.001).toFixed(3) + ' BTC)';
frontend/index.html:65733:          '<div class="v-kpi"><span class="v-kpi-lbl">Position Size</span><span class="v-kpi-num">' + pos.size + ' lots</span><span class="v-kpi
frontend/index.html:66049:          extraInfo = '<div style="font-size:10.5px;color:' + (isLight ? '#475569' : '#cbd5e1') + ';margin-top:3px;">BTC Spot: $' + Math.round(i
frontend/index.html:66876:        <span id="vFpnlSymbolBadge" class="v-fpnl-badge">BTC</span>
frontend/index.html:66934:        return 'BTC';
frontend/public/trade-clock.html:7:  <title>BTC Short Strangle — Trade Clock & Year Calendar</title>
frontend/public/trade-clock.html:1729:          '<div class="tc-title">BTC Short Strangle — Trade Clock &amp; Year Calendar</div>' +
frontend/public/trade-clock.html:2011:            kvBox("BTC move", num(c.move) + "%") +
frontend/public/trade-clock.html:2239:      /* -------- BTC ROAD CHART (entry + exit marked on price) -------- */
frontend/public/trade-clock.html:2307:          '<div class="tc-h2"><span class="tc-ic">🛣️</span>Your Road on BTC &mdash; where you got in &amp; out</div>' +
frontend/public/trade-clock.html:2308:          '<div class="tc-dayhint" style="margin-bottom:10px">The white line is BTC on the selected night. The green dashed rails ar
frontend/public/trade-clock.html:2311:          '<span><b style="color:#dce6f2">&mdash;</b> BTC price (15m)</span>' +
frontend/src/main.ts:46:          <div class="brand-title">BTC VOLATILITY DESK</div>
frontend/src/main.ts:53:          <span class="ticker-label">BTC Spot (Binance)</span>
frontend/src/main.ts:135:              <span>BTC/USDT Technical Canvas</span>
frontend/src/main.ts:368:        <span>BTC Volatility Desk v2.0 · Migrated from Browser Storage</span>
frontend/src/main.ts:623:    const res = await fetch('/api/v1/market/candles?symbol=BTCUSDT&interval=1d&limit=100');
```

## Appendix B: lot-size and settlement-time assumptions

```text
backend/src/lib/algo/plan.ts:26:/** DDMMYY of an expiry instant (Delta settles daily options at 12:00 UTC). */
backend/src/lib/algo/plan.ts:104:  // premium collected by the sold legs, at the bid, in USD (one lot = 0.001 BTC)
backend/src/lib/algo/plan.ts:105:  const premium = legs.reduce((s, l) => s + (l.side === 'sell' ? l.bid * l.lots * 0.001 : -l.ask * l.lots * 0.001), 0);
backend/src/lib/algo/profit.ts:18:/** One lot is 0.001 BTC and Delta quotes option prices and theta per 1 BTC. */
backend/src/lib/algo/profit.ts:19:const LOT = 0.001;
backend/src/lib/bot/calendar.ts:11:export const CAL_ENTRY_MIN_IST = 18 * 60; // 18:00 IST, half an hour after the daily 17:30 IST expiry roll
backend/src/lib/bot/costs.ts:41:  contractValue: number;
backend/src/lib/bot/costs.ts:54:  const notional = i.spot * i.lots * i.contractValue;
backend/src/lib/bot/costs.ts:55:  const premium = i.price * i.lots * i.contractValue;
backend/src/lib/bot/costs.ts:63:  contractValue: number;
backend/src/lib/bot/costs.ts:70:  return i.rate * i.price * i.lots * i.contractValue * (1 + gst);
backend/src/lib/bot/futures-replay.ts:85:    const exitFee = futuresFee({ price, lots: o.lots, contractValue: cfg.contractValue, rate: maker ? cfg.makerRate : cfg.takerRa
backend/src/lib/bot/futures-replay.ts:86:    const p = futuresPnl(o.st.dir, o.st.entry, price, o.lots, o.entryFee, exitFee, cfg.contractValue);
backend/src/lib/bot/futures-replay.ts:94:      marginUsd: (o.st.entry * o.lots * cfg.contractValue) / o.leverage, feesUsd: p.fees, netPnl: p.net, exitReason: reason,
backend/src/lib/bot/futures-replay.ts:112:      const mtm = futuresPnl(o.st.dir, o.st.entry, b.c, o.lots, o.entryFee, 0, cfg.contractValue).net;
backend/src/lib/bot/futures-replay.ts:149:      const entryFee = futuresFee({ price: p.entry, lots: p.lots, contractValue: cfg.contractValue, rate: cfg.takerRate });
backend/src/lib/bot/futures.ts:28:  contractValue: number;
backend/src/lib/bot/futures.ts:60:  contractValue: 0.001,
backend/src/lib/bot/futures.ts:362:  const size = futuresLots({ riskUsd: cfg.riskUsd, stopDistance: dist, contractValue: cfg.contractValue, maxLots: cfg.maxLots });
backend/src/lib/bot/futures.ts:366:  const fee = futuresFee({ price: entry, lots: size.lots, contractValue: cfg.contractValue, rate: cfg.takerRate }) * 2;
backend/src/lib/bot/futures.ts:435:export function futuresPnl(dir: Dir, entry: number, exit: number, lots: number, entryFee: number, exitFee: number, contractValue = 0.00
backend/src/lib/bot/futures.ts:436:  const gross = (dir === 'long' ? exit - entry : entry - exit) * lots * contractValue;
backend/src/lib/bot/learn.ts:76:const CONTRACT_VALUE = 0.001;
backend/src/lib/bot/learn.ts:89:      contractValue: CONTRACT_VALUE,
backend/src/lib/bot/paper-terminal.ts:22:  contractValue: number;
backend/src/lib/bot/paper-terminal.ts:115:    return optionFee({ price, lots, contractValue: inst.contractValue, spot, rate, premiumCapRate: inst.premiumCapRate });
backend/src/lib/bot/paper-terminal.ts:117:  return futuresFee({ price, lots, contractValue: inst.contractValue, rate });
backend/src/lib/bot/paper-terminal.ts:203:      optionsValue += p.lots * inst.contractValue * mark;
backend/src/lib/bot/paper-terminal.ts:210:      perpUnrealized += unrealized(p, mark, inst.contractValue);
backend/src/lib/bot/paper-terminal.ts:211:      if (mode === 'standard') perpMargin += (Math.abs(p.lots) * inst.contractValue * mark) / Math.max(p.leverage, 1);
backend/src/lib/bot/paper-terminal.ts:216:  const optionMargin = !optPos.length ? 0 : mode === 'standard' ? standardOptionMargin(shorts, m.spot, 0.001) : portfolioMargin(
backend/src/lib/bot/paper-terminal.ts:217:  if (mode === 'portfolio' && futLots !== 0) perpMargin = portfolioMargin(optPos, m.spot, m.nowMs, 0.001, futLots).margin - opti
backend/src/lib/bot/paper-terminal.ts:231:  if (inst.kind === 'option') return (side === 'sell' ? 1 : -1) * price * lots * inst.contractValue - fee;
backend/src/lib/bot/paper-terminal.ts:267:  contractValue: number;
backend/src/lib/bot/paper-terminal.ts:286:    total += dir * (intrinsic - l.price) * l.lots * l.contractValue;
backend/src/lib/bot/paper-terminal.ts:299:  const upSlope = legs.reduce((s, l) => s + (l.type === 'call' ? (l.side === 'buy' ? 1 : -1) * l.lots * l.contractValue : 0), 0)
backend/src/lib/bot/paper-terminal.ts:303:  const netPremium = legs.reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.price * l.lots * l.contractValue, 0);
backend/src/lib/bot/portfolio-margin.ts:85:  contractValue = 0.001,
backend/src/lib/bot/portfolio-margin.ts:92:  const futNotional = Math.abs(futuresLots) * contractValue * spot;
backend/src/lib/bot/portfolio-margin.ts:93:  const notional = positions.reduce((s, p) => s + spot * p.lots * contractValue, 0) + futNotional;
backend/src/lib/bot/portfolio-margin.ts:107:      pnl += sign * (v - base[i]!) * p.lots * contractValue;
backend/src/lib/bot/portfolio-margin.ts:109:    pnl += futuresLots * contractValue * (s - spot);
backend/src/lib/bot/portfolio-margin.ts:131:  const shortNotional = shorts.reduce((s, p) => s + spot * p.lots * contractValue, 0);
backend/src/lib/bot/portfolio-margin.ts:132:  const longNotional = longs.reduce((s, p) => s + spot * p.lots * contractValue, 0);
backend/src/lib/bot/portfolio-margin.ts:133:  const premiumOf = (p: MarginPosition) => base[positions.indexOf(p)]! * p.lots * contractValue;
backend/src/lib/bot/portfolio-margin.ts:135:    const n = spot * p.lots * contractValue;
backend/src/lib/bot/portfolio-margin.ts:139:    const n = spot * p.lots * contractValue;
backend/src/lib/bot/replay.ts:38:  contractValue: number;
backend/src/lib/bot/replay.ts:54:  contractValue: 0.001,
backend/src/lib/bot/replay.ts:90:/** Daily option expiries settle at 12:00 UTC. */
backend/src/lib/bot/replay.ts:155:  return optionFee({ price, lots: cfg.lots, contractValue: cfg.contractValue, spot, rate: cfg.feeRate, premiumCapRate: cfg.feePremiumCap
backend/src/lib/bot/replay.ts:160:  return portfolioMargin(pos, spot, t, cfg.contractValue).margin;
backend/src/lib/bot/replay.ts:289:    const snapClose: PositionSnapshot = { legs, marks: closeMarks, spot: b.c, marginUsd, contractValue: cfg.contractValue, feesPaidUsd: 
backend/src/lib/bot/replay.ts:340:  const gross = legs.reduce((s, l, i) => s + (l.side === 'short' ? l.entryPrice - exits[i]! : exits[i]! - l.entryPrice) * l.lots * cfg.c
backend/src/lib/bot/rules.ts:5: * a lot is `contractValue` BTC (0.001), so per-leg PnL is price move x lots x contractValue.
backend/src/lib/bot/rules.ts:12:    return { symbol: leg.symbol, pnl: move * leg.lots * p.contractValue };
backend/src/lib/bot/sizing.ts:7:  /** Underlying per lot (0.001 BTC), so one lot gains/loses contractValue USD per 1 USD move. */
backend/src/lib/bot/sizing.ts:8:  contractValue: number;
backend/src/lib/bot/sizing.ts:20:  if (!(i.stopDistance > 0) || !(i.riskUsd > 0) || !(i.contractValue > 0)) return null;
backend/src/lib/bot/sizing.ts:21:  const raw = Math.floor(i.riskUsd / (i.stopDistance * i.contractValue));
backend/src/lib/bot/sizing.ts:24:  return { lots, riskAtStopUsd: lots * i.stopDistance * i.contractValue };
backend/src/lib/bot/types.ts:28:  /** Lots (Delta contract_value, 0.001 BTC per lot, converts to underlying size). */
backend/src/lib/bot/types.ts:64:  /** Contract value in underlying units per lot (0.001 BTC). */
backend/src/lib/bot/types.ts:65:  contractValue: number;
backend/src/lib/pulse/cohort.ts:38:  const cv = i.fee.contractValue;
backend/src/lib/pulse/cohort.ts:41:    optionFee({ price, lots, contractValue: cv, spot: i.spot, rate: i.fee.takerRate, premiumCapRate: i.fee.premiumCapRate });
backend/src/lib/pulse/cohort.ts:51:  const feeFor = (price: number) => futuresFee({ price, lots, contractValue: cv, rate });
backend/src/lib/pulse/config.ts:24:  futuresContractValue: 0.001,
backend/src/lib/pulse/snapshot.ts:231:    const collected = ((cohort.call_bid as number) + (cohort.put_bid as number)) * PULSE_CONFIG.lots * cohort.fee.contractValue;
backend/src/routes/bot.ts:51:      `SELECT r.*, (SELECT COALESCE(SUM(ABS(f.avg_price - f.intended_price) * f.filled * 0.001), 0)::float FROM bot_fills f WHERE f.run_id = 
backend/src/routes/bot.ts:167:    const slippage = fills.rows.reduce((s: number, f: any) => s + Math.abs(Number(f.avg_price) - Number(f.intended_price)) * f.filled * 0.00
backend/src/routes/bot.ts:173:        pnl: l.exit_price == null ? null : (l.side === 'short' ? Number(l.entry_price) - Number(l.exit_price) : Number(l.exit_price) - Numbe
backend/src/routes/paper.ts:74:        success: true, spot: snap.spot, perp: snap.perp, perpInfo: { contractValue: perp.contractValue, maxLeverage: perp.maxLeverage, tick
backend/src/routes/pnl.ts:42:  contract_value: z.coerce.number().optional(),
backend/src/routes/pnl.ts:109:      contract_value: q.contract_value !== undefined ? q.contract_value : (basePosition?.contract_value ?? 0.001),
backend/src/services/algo/algo-engine.ts:241:      // dollars of profit or loss on the position: one lot is 0.001 BTC
backend/src/services/algo/algo-engine.ts:242:      const usdMove = (side === 'long' ? mark - entry : entry - mark) * r.lots * 0.001;
backend/src/services/algo/algo-service.ts:88:  const notional = lots * 0.001 * m.spot;
backend/src/services/algo/brokers.ts:12:/** The price at which a futures stop of `futStopUsd` dollars (or, for older rules, a percent) is hit. One lot is 0.001 BTC, so $1
backend/src/services/algo/brokers.ts:15:    const move = exit.futStopUsd / (lots * 0.001);
backend/src/services/algo/live-entry.ts:168:          const mid = (bid + ask) / 2, pnl = (p.size < 0 ? p.entry - mid : mid - p.entry) * Math.abs(p.size) * 0.001;
backend/src/services/ask/answer.ts:73:  EVE_LONG: 'Buys the ATM straddle (call and put at the same strike) on the next expiry at 17:30 IST, every day. Exits: +50% of marg
backend/src/services/ask/answer.ts:203:  const slips = await c.q('SELECT SUM(ABS(avg_price - intended_price) * filled * 0.001)::float AS s FROM bot_fills WHERE run_id = $
backend/src/services/ask/answer.ts:414:    table: { head: ['Date', 'Verdict', 'Outcome', 'IV 17:30', 'IV NY open', 'Speed/IV', 'ADX', 'Notes'], rows: rows.map((r) => [Str
backend/src/services/bot/bot-engine.ts:36:const CONTRACT_VALUE = 0.001;
backend/src/services/bot/bot-engine.ts:525:    const snap = { legs: run.legs, marks, spot: chain.spot, marginUsd: run.marginUsd, contractValue: CONTRACT_VALUE, feesPaidUs
backend/src/services/bot/bot-engine.ts:582:      const snap = { legs: run.legs, marks, spot: chain.spot, marginUsd: run.marginUsd, contractValue: CONTRACT_VALUE, feesPaid
backend/src/services/bot/bot-engine.ts:650:      const snap = { legs: run.legs, marks, spot: chain.spot, marginUsd: run.marginUsd, contractValue: CONTRACT_VALUE, feesPaid
backend/src/services/bot/delta-public.ts:44: * Daily options settle at 12:00 UTC (17:30 IST).
backend/src/services/bot/delta-public.ts:46:export function parseExpiry(symbol: string): number | null {
backend/src/services/bot/delta-public.ts:60:  const expiryMs = parseExpiry(symbol);
backend/src/services/bot/delta-public.ts:146:  contractValue: number;
backend/src/services/bot/delta-public.ts:149:export const DEFAULT_OPTION_FEES: FeeRates = { takerRate: 0.0001, makerRate: 0.0001, premiumCapRate: 0.035, contractValue: 0.
backend/src/services/bot/delta-public.ts:160:        contract_value?: string;
backend/src/services/bot/delta-public.ts:170:        contractValue: num(p.contract_value) || DEFAULT_OPTION_FEES.contractValue,
backend/src/services/bot/delta-public.ts:193:  contractValue: number;
backend/src/services/bot/delta-public.ts:200:export const DEFAULT_PERP: PerpInfo = { symbol: 'BTCUSD', contractValue: 0.001, takerRate: 0.0005, makerRate: 0.0002, maxLeve
backend/src/services/bot/delta-public.ts:206:      result?: { symbol: string; contract_value?: string; taker_commission_rate?: string; maker_commission_rate?: string; def
backend/src/services/bot/delta-public.ts:212:      contractValue: num(r.contract_value) || DEFAULT_PERP.contractValue,
backend/src/services/bot/futures-live.ts:213:    const marginUsd = (entry * p.lots * this.cfg.contractValue) / p.leverage;
backend/src/services/bot/futures-live.ts:219:    const fee = futuresFee({ price: entry, lots: p.lots, contractValue: this.perp.contractValue, rate: this.perp.takerRate })
backend/src/services/bot/futures-live.ts:252:    const exitFee = futuresFee({ price, lots: run.st.lots, contractValue: this.perp.contractValue, rate });
backend/src/services/bot/futures-live.ts:253:    const pnl = futuresPnl(run.st.dir, run.st.entry, price, run.st.lots, run.entryFee, exitFee, this.perp.contractValue);
backend/src/services/bot/futures-live.ts:273:      const pnl = futuresPnl(run.st.dir, run.st.entry, px, run.st.lots, run.entryFee, 0, this.perp.contractValue);
backend/src/services/bot/futures-live.ts:293:      const pnl = px == null ? null : futuresPnl(run.st.dir, run.st.entry, px, run.st.lots, run.entryFee, 0, this.perp.contra
backend/src/services/bot/paper-broker.ts:65:      ? optionFee({ price: w.avgPrice, lots: leg.lots, contractValue: r.contractValue, spot, rate: r.takerRate, premiumCapRate
backend/src/services/greek-pnl.ts:5: *   delta_pnl   = quantity * contract_value * delta * delta_spot
backend/src/services/greek-pnl.ts:6: *   gamma_pnl   = 0.5 * quantity * contract_value * gamma * (delta_spot ** 2)
backend/src/services/greek-pnl.ts:15:  contract_value?: number; // usually 0.001 BTC per contract on Delta
backend/src/services/greek-pnl.ts:46:  const contract_value = position.contract_value !== undefined ? Number(position.contract_value) : 0.001;
backend/src/services/greek-pnl.ts:69:  const delta_pnl = normalizeZero(quantity * contract_value * delta * delta_spot);
backend/src/services/greek-pnl.ts:70:  const gamma_pnl = normalizeZero(0.5 * quantity * contract_value * gamma * (delta_spot ** 2));
backend/src/services/paper/market.ts:2:import { DEFAULT_PERP, deltaGet, fetchBook, fetchOptionFeeRates, fetchPerpInfo, parseExpiry, type Book, type DeltaTicker } from '..
backend/src/services/paper/market.ts:62:  const expiryMs = symbol ? parseExpiry(symbol) : null;
backend/src/services/paper/market.ts:139:      symbol: info.symbol, kind: 'perp', contractValue: info.contractValue, takerRate: info.takerRate, makerRate: info.makerRate,
backend/src/services/paper/market.ts:145:        symbol: r.symbol, kind: 'option', contractValue: f?.contractValue ?? 0.001, takerRate: f?.takerRate ?? 0.0001, makerRate:
backend/src/services/paper/paper-terminal.ts:12:import { parseExpiry } from '../bot/delta-public.js';
backend/src/services/paper/paper-terminal.ts:204:  const expiryMs = parseExpiry(symbol);
backend/src/services/paper/paper-terminal.ts:304:    const { pos: np, realized } = applyTrade(pos, signed(side, lots), price, inst.contractValue, leverage, inst.symbol);
backend/src/services/paper/paper-terminal.ts:315:      reason = `not enough cash to pay the ${money(price * lots * inst.contractValue)} premium plus fees (cash ${money(st
backend/src/services/paper/paper-terminal.ts:323:    const slip = maker || !Number.isFinite(bestPrice) ? 0 : Math.abs(price - bestPrice) * lots * inst.contractValue;
backend/src/services/paper/paper-terminal.ts:406:      const premium = inst.kind === 'option' ? (req.side === 'sell' ? 1 : -1) * refPrice * refLots * inst.contractValue :
backend/src/services/paper/paper-terminal.ts:410:        slippageUsd: w.filled > 0 ? Math.abs(w.avgPrice - w.best) * w.filled * inst.contractValue : 0, fee: sim.fee,
backend/src/services/paper/paper-terminal.ts:587:        const cv = inst?.contractValue ?? 0.001;
backend/src/services/paper/paper-terminal.ts:590:        const pm = inst?.kind === 'perp' && mark != null && st.mode === 'portfolio' ? portfolioMargin([], snap!.spot, Dat
backend/src/services/paper/paper-terminal.ts:618:      if (p.symbol === snap.perp.symbol) { delta += p.lots * 0.001; continue; }
backend/src/services/paper/paper-terminal.ts:621:      const size = p.lots * 0.001;
backend/src/services/paper/paper-terminal.ts:669:      const { pos: np, realized } = applyTrade(cur, signed(p.side, p.lots), p.price, p.inst.contractValue, cur?.leverage 
backend/src/services/paper/paper-terminal.ts:673:      slippageUsd += Math.abs(p.price - p.best) * p.lots * p.inst.contractValue;
backend/src/services/paper/paper-terminal.ts:674:      if (p.inst.kind === 'option') netPremium += (p.side === 'sell' ? 1 : -1) * p.price * p.lots * p.inst.contractValue;
backend/src/services/paper/paper-terminal.ts:689:      ? payoffSummary(opts.map((p): PayoffLeg => ({ type: p.inst.option!.type, strike: p.inst.option!.strike, side: p.sid
backend/src/services/paper/paper-terminal.ts:939:            pnl: ref == null ? null : sign * (ref - entry) * Number(l.lots) * 0.001,
backend/src/services/paper/paper-terminal.ts:987:      const { realized } = applyTrade(pos, -pos.lots, px, 0.001, 1, pos.symbol);
backend/src/services/paper/paper-terminal.ts:989:      const cash = st.cash + (side === 'sell' ? 1 : -1) * px * Math.abs(pos.lots) * 0.001;
backend/src/services/paper/paper-terminal.ts:1145:      if (!st || !base || !inst) return { ...r, sellMargin: null as number | null, sellOk: null as boolean | null, buyCo
backend/src/services/paper/paper-terminal.ts:1148:      const { pos: np } = applyTrade(cur, -lots, price, inst.contractValue, cur?.leverage ?? DEFAULT_LEVERAGE, r.symbol)
backend/src/services/paper/paper-terminal.ts:1155:      return { ...r, sellMargin: Math.max(v.margin - base.margin, 0), sellOk: !grows || v.available >= 0, buyCost: r.ask
backend/src/services/self-testing-audit.ts:54:  const istDate = new Date(timeMs + 19800000); // UTC + 5.5 hours
backend/src/services/watch/real-tracker.ts:13:const LOT_BTC = 0.001, SETTLE_MS = 30_000;
frontend/index.html:6:    (IV below its 17:30 level · 1-h ADX falling · Speed vs IV < 1.5×), ADX ring, Speed vs IV rays every 15 min, IV line
frontend/index.html:251:  · Edge: a fresh listing was blanked for 3 h; the N2N daily lists at the 17:30 roll, so Edge showed nothing for N2N until 20:30.
frontend/index.html:281:  after the 17:30 roll. style#v105Polish: presentation layer (surfaces, ticker master cell, master switch, pane accents, tabs).
frontend/index.html:340:  21:30 after 1 Nov) → exit 17:00 IST next day (switch 17:30, localStorage v92_exit); Asia 09:00–10:00 IST → 04:15; London open
frontend/index.html:349:  the clock, bid rose, DVOL agrees, speed > 1×, holds 2 candles; known fakes: new listing, 17:30 roll, thin hours).
frontend/index.html:361:  VoV fast · Term · event); Tonight rail (17:30→17:30 IST: phase bands, bid IV of the plan expiry vs the clock path
frontend/index.html:362:  IVclock = IV(17:30 listing) × √[share(t→settle)/share(17:30→settle)] from Clock24, average of the last 5 weekdays, now marker,
frontend/index.html:399:  v84 Speed vs IV (10 Oct 2026, measured only): BTC realised (1-m Parkinson) ÷ ATM IV of the chosen expiry (Cur / Next / N2N switch, default N2N;
frontend/index.html:21451:                <p><b>To expiry</b> uses time to Delta's 17:30 IST settlement.</p>
frontend/index.html:21780:         strikes, time-to-expiry measured to 17:30 IST settlement, sessions
frontend/index.html:21795:    const EXPIRY_UTC_HOUR = 12;           // Delta India BTC options settle 17:30 IST = 12:00 UTC
frontend/index.html:21796:    const IST_OFFSET_MS = 19800000;       // IST is UTC+5:30, no daylight saving
frontend/index.html:21849:      const H = 3600000, D = 86400000, IST = 19800000, MAIN = ['ASIA', 'LONDON', 'NEW YORK'];
frontend/index.html:22865:    const IST_SEC = 19800;
frontend/index.html:24632:      const c = N(x.oi_contracts); if (c > 0) return c * (N(x.contract_value) || 0.001); const o = N(x.oi ?? x.open_interest); return o > 0 ? o 
frontend/index.html:25410:          if (q) { const t = K.tone(q), ar = q.falling ? ' ▼' : q.rising ? ' ▲' : ''; spd = `<span class="spd-chip ${t}" title="Speed of the
frontend/index.html:25570:         17:30 IST roll, recorder gaps over 45 minutes, and the last hour of an
frontend/index.html:26598:      const IST = 19800000, NSTART = Date.UTC(2020, 0, 1), NIGHT_KEY = 'edge_nights_v1', NIGHT_BARS = 20;
frontend/index.html:26798:       For every scheduled US release that lands after 17:30 IST, measure how
frontend/index.html:26859:      function nightOf(t) {                    // v80: the Delta expiry day (17:30 IST → 17:30 IST) a release belongs to; key = settlement dat
frontend/index.html:27226:      const IST = typeof IST_SEC === 'number' ? IST_SEC : 19800;
frontend/index.html:27743:      const IST_S = typeof IST_SEC === 'number' ? IST_SEC : 19800, IST_MS = IST_S * 1000;
frontend/index.html:28272:      const hms = ms => new Date(ms + (typeof IST_OFFSET_MS === 'number' ? IST_OFFSET_MS : 19800000)).toISOString().slice(11, 19);
frontend/index.html:28888:              if (c.last) { const d = new Date(c.last.t0 + 19800000); window.RegLayers.deskLine({ on: true, lab: (tf >= 86400 ? '' : '4h from ')
frontend/index.html:28983:        srcLabel(); setInterval(srcLabel, 5000);          // expiries roll at 17:30 IST and panes can be re-pinned
frontend/index.html:29555:      const IST = typeof IST_SEC === 'number' ? IST_SEC : 19800;
frontend/index.html:30435:      const IST = 19800, DAY = 86400, SLOT = 900;
frontend/index.html:30607:      const IST = 19800, DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG',
frontend/index.html:30663:      const DBN = 'suraj_archive_v1', ST = ['iv', 'btc', 'flow', 'nights', 'events', 'meta', 'days'], MIN = 1440, DAYMS = 86400000, ISTMS = 1980
frontend/index.html:31316:      const DAY = 86400000, ISTMS = 19800000, H = 3600000;
frontend/index.html:32023:      // the night a time belongs to: 17:30 IST to 07:00 IST next morning
frontend/index.html:32554:      const nowChart = () => Math.floor(Date.now() / 1000) + 19800;
frontend/index.html:32864:      const IST = 19800000; const p2 = n => String(n).padStart(2, '0');
frontend/index.html:32947:         d. Delta                     panes[0|2|1].expiry daily expiries 12:00 UTC + /v2/tickers OI + max pain
frontend/index.html:32959:        const IST_MS = (typeof IST_OFFSET_MS === 'number') ? IST_OFFSET_MS : 19800000;   // IST = UTC+5:30, no DST (engine 2707)
frontend/index.html:33144:        // OI in BTC, same precedence as the engine's deltaOiBtc() (5372): oi_value_usd/spot → oi_contracts×contract_value → oi
frontend/index.html:33145:        function oiBtc(r) { const usd = +r.oi_value_usd, sp = +r.spot_price || gSpot(); if (usd > 0 && sp > 0) return usd / sp; const c = +r.oi_
frontend/index.html:33164:            title: 'Delta expiry' + (chain && chain.oi > 0 ? ' · ' + fmtBtc(chain.oi) + ' BTC OI' : ''), small: (SLOT[slot] || '') + (chain && 
frontend/index.html:33372:          const dl = first('DELTA_EXP', nextUtc(now, [12], DAY), 'Delta expiry 17:30 IST'), db = first('DERIBIT_EXP', nextUtc(now, [8], DAY), 'D
frontend/index.html:33477:      const DELTA_CONTRACT_BTC = 0.001;            // Delta India BTCUSD perp: 1 contract = 0.001 BTC (assumption, see orderflow.md)
frontend/index.html:33483:      const IST = typeof IST_SEC === 'number' ? IST_SEC : 19800;
frontend/index.html:33966:      const MIN = 60000, HR = 3600000, DAY = 86400000, IST_MS = 19800000, YEAR_H = 8760;
frontend/index.html:33991:      function expiryMs(e) { if (!/^\d{4}-\d{2}-\d{2}$/.test(e || '')) return null; const [y, m, d] = e.split('-').map(Number); return Date.UTC(
frontend/index.html:34575:      const HR = 3600e3, DAY = 86400e3, IST = 19800, START = Date.UTC(2021, 3, 1);
frontend/index.html:35277:      const B15 = 900000, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800, LOOK = 48 * HR;
frontend/index.html:35297:      // Current only: the last 2 h before the 17:30 IST (12:00 UTC) settlement have jumpy IV, so those blocks are left out
frontend/index.html:35487:      const W = window, KEY = 'v88:ivba:v1', KEEP = 35 * 86400, DAYS = 86400, ISTs = typeof IST_SEC === 'number' ? IST_SEC : 19800;
frontend/index.html:35619:      function outOf(p) { if (!(p && p.mk > 0)) return null; const up = p.mk - p.a, dn = p.b - p.mk; return up >= 0.001 ? { s: 1, d: up } : dn >
frontend/index.html:35736:      const W = window, $ = id => document.getElementById(id), DAY = 86400, IST = typeof IST_SEC === 'number' ? IST_SEC : 19800;   // IV candle 
frontend/index.html:35739:      const wd = t => { const d = new Date((t - 19800) * 1000).getUTCDay(); return d !== 0 && d !== 6; };          // v89: chart times are IST-s
frontend/index.html:36566:      const W = window, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000;
frontend/index.html:36569:      const wkday = d => { const t = d * DAY - IST + 12 * HR, w = new Date(t).getUTCDay(); return w !== 0 && w !== 6; };   // IST day d, judged 
frontend/index.html:36628:      // exit: New York → 17:00 IST (or 17:30) on the day after entry; Asia / London → 75 min before that session next opens
frontend/index.html:36654:      const W = window, D = document, HR = 3600000, DAY = 86400000, IST = 19800000, PK = 1 / (4 * Math.LN2);
frontend/index.html:36802:      const IST_S = 19800;
frontend/index.html:37032:      const W = window, D = document, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000, YEAR = 8760;
frontend/index.html:37082:      // most recent 17:30 IST listing (12:00 UTC)
frontend/index.html:37209:        const nextTokyo = (() => { let t = Math.floor((now + IST) / DAY) * DAY - IST + 5.5 * HR; if (t <= now) t += DAY; return t; })(); if (new
frontend/index.html:37257:        out.push({ a: start, b: data, c: '--faint', l: '17:30 settle · new daily' }, { a: data, b: ny, c: '--amber', l: 'US data ' + hm(data) }
frontend/index.html:37263:        const head = `<div class="h89">⏱ Tonight<span class="s">17:30 → 17:30 IST · ${R && R.isBid ? 'bid' : 'mark'} IV vs the clock path �
frontend/index.html:37265:        if (!R) { el.innerHTML = head + (() => { try { return W.v115 && W.v115.trapHtml ? W.v115.trapHtml() : ''; } catch (e) { return ''; } })(
frontend/index.html:37362:              return R.bars.map(b => ({ t: (b.time - 19800) * 1000, h: b.high, l: b.low, c: b.close }));
frontend/index.html:37818:      const W = window, D = document, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000, ISTS = 19800;
frontend/index.html:37872:        for (const s of [0, 1, 2]) { const e = expOfSlot(s), st = e ? settleOf(e) : null; h += `<button type="button" data-s="${s}" aria-pressed
frontend/index.html:37976:          return { type: m[1].toUpperCase(), K: +m[2], exp: '20' + m[5] + '-' + m[4] + '-' + m[3], size: N(p.size), entry: N(p.entry_price), cv:
frontend/index.html:37987:        return { id, src: 'api', exp: e, Kp: P.K, Kc: C.K, lot: P.cv || 0.001, fills, openedAt: fills[0].t };
frontend/index.html:38096:      const W = window, D = document, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000, ISTS = 19800;
frontend/index.html:38171:          /* v105.15: a fresh listing used to be blanked for 3 h. The N2N daily lists at the 17:30 roll, so Edge showed nothing for
frontend/index.html:38799:      const W = window, D = document, MIN = 60000, HR = 3600000, DAY = 86400000, YR = 365 * DAY, IST = 19800000;
frontend/index.html:40675:      const W = window, D = document, MIN = 60000, HR = 3600000, DAY = 86400000, ISTS = 19800, STEP = 5 * MIN;
frontend/index.html:40685:      const exitTxt = () => { try { return localStorage.getItem('v92_exit') === '1730' ? '17:30' : '17:00'; } catch (e) { return '17:00'; } };
frontend/index.html:40892:        const IST = 19800000, today = Math.floor((Date.now() + IST) / DAY), days = new Map();
frontend/index.html:41043:         (synced only while the old console ran). This keeps them on the master expiry and re-checks after every 17:30 roll. */
frontend/index.html:41105:        const hm = ms => { const d = new Date(ms + 19800000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).
frontend/index.html:42028:      const hm = t => { const d = new Date(t + 19800000); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padS
frontend/index.html:42029:      const day = t => { const d = new Date(t + 19800000); return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'
frontend/index.html:42080:          const size = N(p.size); if (!size) continue; L.push({ sym, type: m[1].toUpperCase(), K: +m[2], exp: '20' + m[5] + '-' + m[4] + '-' + m
frontend/index.html:42447:    <p class="s" style="margin:4px 0 8px">No strangle open. What the premium carries if you sell the 0.12-delta put and call on the master expir
frontend/index.html:42741:      const alIst = ms => new Date(ms + 19800000).toISOString().slice(5, 16).replace('T', ' ');
frontend/index.html:43998:      const W = window, D = document, B15 = 900000, IST_S = 19800, RED = '239,83,80', GRN = '38,166,154', GREY = '139,159,177';
frontend/index.html:44174:        // speed strip along the rail's 17:30 → 17:30 axis
frontend/index.html:44487:        const now = Date.now() / 1000 + 19800, inNY = s.day && s.day.ny && now >= s.day.L1 && now < s.day.N1, ag = s.agreeNow || { n: 0, of: 0 }
frontend/index.html:45089:      const W = window, D = document, fin = Number.isFinite, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000;
frontend/index.html:45184:        TRAP_MINS_END: 1080,    // 18:00 IST (17:30 IST Settlement Trap, p < 0.0000001)
frontend/index.html:45232:          const istMins = (new Date(now + 19800000).getUTCHours()) * 60 + (new Date(now + 19800000).getUTCMinutes());
frontend/index.html:45551:      const W = window, D = document, fin = Number.isFinite, IST = 19800, M = 60, H = 3600;
frontend/index.html:46017:      const W = window, D = document, fin = Number.isFinite, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000;
frontend/index.html:47474:      const IST = 19800000, DAY = 86400000, esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&g
frontend/index.html:47517:          return { t: x.openedAt, c: x.closedAt || null, Kc: x.Kc, Kp: x.Kp, exp: x.exp, lots, cr, lot: x.lot || 0.001, pnl: fin(x.pnlUsd) ? x.p
frontend/index.html:47663:          expired contracts settled at the Delta BTC index at 17:30 IST) → one row per expiry (strangle), call vs put legs. */
frontend/index.html:47666:      const MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000;
frontend/index.html:47753:            const sym = f.product_symbol || (f.product && f.product.symbol); const s = parseSym(sym); if (!s) continue; const cv = +(f.product &
frontend/index.html:47798:   <p class="src" style="margin:0">From your Delta fills (signed, read-only). Each contract: sells − buys − commission; a contract held to e
frontend/index.html:47853:      'use strict'; const W = window, D = document, $ = id => D.getElementById(id); const MIN = 6e4, HR = 36e5, DAY = 864e5, IST = 19800;
frontend/index.html:48235:      const MIN = 6e4, HR = 36e5, DAY = 864e5, IST = 19800000; const fin = Number.isFinite;
frontend/index.html:48413:        return `<div class="v6c t ${g.c || 'b'}"><span class="l">TONIGHT · ${DN[d]} PLAYBOOK · N2N ${EXP[d].toUpperCase()} 17:30</span><b styl
frontend/index.html:48439:        return `<div class="v6c v6ban t b"><div style="display:flex;flex-direction:column;gap:2px"><span class="l">WEEKEND ENTRY · N2N ${esc(F.
frontend/index.html:48442:    <div class="g4">${T(1, 'NEWS TO MONDAY', ev.length ? ev[0].code + ' ' + hm(ev[0].t) : 'CLEAR', ev.length ? 'High-impact release before Mon 1
frontend/index.html:48676:      const MIN = 6e4, HR = 36e5, DAY = 864e5, ISTS = 19800, IST = ISTS * 1000; const fin = Number.isFinite; const API = 'https://api.india.delt
frontend/index.html:49267:      const MIN = 6e4, HR = 36e5, DAY = 864e5, ISTS = 19800, IST = ISTS * 1000; const fin = Number.isFinite;
frontend/index.html:49572:          band.firstChild.textContent = `±1σ to ${R.F.n2n.slice(5)} 17:30 · ±${(sd * 100).toFixed(1)}%`;
frontend/index.html:49938:      const MIN = 6e4, HR = 36e5, DAY = 864e5, IST = 19800000; const fin = Number.isFinite; const API = 'https://api.india.delta.exchange';
frontend/index.html:49953:        const istMins = (new Date(now + 19800000).getUTCHours()) * 60 + (new Date(now + 19800000).getUTCMinutes());
frontend/index.html:50513:      'use strict'; const W = window, fin = Number.isFinite, HR = 36e5, ISTS = 19800, ANN = Math.sqrt(24 * 365);
frontend/index.html:50554:              const u = (H[String(new Date(now + 19800000).getUTCHours())] || []).map(q => q[1]).sort((x, y) => x - y), usual = u.length >= 6 ? 
frontend/index.html:50716:        const r = RK(); if (!r) return null; const nowIst = Date.now() + 19800000, d = date || new Date(nowIst - (new Date(nowIst).getUTCHours()
frontend/index.html:50846:          const t = new Date(Date.now() + 19800000), wd = t.getUTCDay(), mins = t.getUTCHours() * 60 + t.getUTCMinutes(); if (wd < 1 || wd > 5 |
frontend/index.html:50918:        const first = bars[0].time * 1000 - 19800000, last = bars[bars.length - 1].time * 1000 - 19800000; if (first > t0 || last < t1 - 10 * 60
frontend/index.html:50922:          const tm = b.time * 1000 - 19800000; if (tm <= t0 || tm > t1) continue; const T = Math.max(T0 - (tm - t0) / YR, 1 / 365 / 24); lastC =
frontend/index.html:51062:      function ist() { const t = new Date(Date.now() + 19800000); return { wd: t.getUTCDay(), h: t.getUTCHours(), m: t.getUTCMinutes() }; }
frontend/index.html:51123:      const W = window, D = document, $ = id => D.getElementById(id), MODE = 'v157_mode', IST = 19800000, H = 3600000, DAY = 86400000;
frontend/index.html:51306:      const W = window, D = document, $ = id => D.getElementById(id), MODE = 'v158_mode', RNG = 'v158_range', IST = 19800000, H = 3600000, DAY =
frontend/index.html:51430:        <div class="kcap" style="padding:0 4px 10px">From your Delta fills (read-only). One row per expiry strangle, net of fees; contracts held
frontend/index.html:51478:        const RMd = W.__STRANGLE_RISKMODEL, DY = W.__STRANGLE_DAILY, DS = W.__SHADOW_BACKTEST_DATA; const t = new Date(Date.now() + 19800000), w
frontend/index.html:51533:      const ist = () => new Date(Date.now() + 19800000).toISOString().slice(11, 16) + ' IST';
frontend/index.html:51671:      const istHM = ts => new Date(ts * 1000 + 19800000).toISOString().slice(11, 16);
frontend/index.html:51701:        let h = `<div class="hd"><div>World markets · 15-minute change<small>Updated ${new Date((lastAt || Date.now()) + 19800000).toISOString(
frontend/index.html:51773:      const W = window, D = document, $ = id => D.getElementById(id), IST = 19800000, HR = 3600000;
frontend/index.html:51787:      /* the N2N daily expiry key (3rd daily expiry; the list rolls at 17:30 IST), same rule as the plan frame */
frontend/index.html:51837:      const W = window, D = document, $ = id => D.getElementById(id), IST = 19800000, HR = 3600000, DAY = 86400000;
frontend/index.html:51915:      const expMs = k => Date.parse(k + 'T12:00:00Z');                                  // dailies expire 12:00 UTC = 17:30 IST
frontend/index.html:51931:        const qty = nLots * 0.001, F = d.F, Tn = Math.max(1e-6, d.T0), Hl = Math.min(d.Hh, Tn * 8760), T1 = Math.max(1e-6, Tn - Hl / 8760), sm =
frontend/index.html:52149:      const W = window, D = document, $ = id => D.getElementById(id), IST = 19800000;
frontend/index.html:52349:      const MIN = 6e4, HR = 36e5, DAY = 864e5, ISTS = 19800, IST = ISTS * 1000, YR = 365 * DAY;
frontend/index.html:54000:      const MIN = 6e4, HR = 36e5, DAY = 864e5, IST = 19800000, ISTS = 19800, YR = 365 * DAY, API = 'https://api.india.delta.exchange';
frontend/index.html:54417:        h.setLeg(o, `<b>IV DRIVER</b><span class="${cls}">${esc(head)}</span>${why ? `<span class="m">${esc(why)}</span>` : ''}<span class="m">1
frontend/index.html:54638:      const W = window, D = document, MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000;
frontend/index.html:54993:      const MIN = 6e4, HR = 36e5, DAY = 864e5, IST = 19800000;
frontend/index.html:55055:        // Catastrophic Settlement Trap: 17:30 IST next day (80.3% stop catastrophe, p < 0.0000001)
frontend/index.html:55056:        r.trapT = D0 + 41.5 * HR; // 17:30 IST next day
frontend/index.html:55289:            { label: 'Weekly Expiry Settlement', val: '17:30 IST (All weekly contracts settle)' },
frontend/index.html:55292:          note: 'Weekly expiry settlement occurs Sunday 17:30 IST.'
frontend/index.html:55334:          title: '17:30 IST · PROHIBITED SETTLEMENT TRAP',
frontend/index.html:55403:            return Object.assign(st, { cls: 'no', word: 'EMERGENCY EXIT', d1: '17:30 IST Settlement Trap', d2: '80.3% stop catastrophe · exit i
frontend/index.html:55405:          return Object.assign(st, { cls: 'hold', word: 'HOLD POSITION', d1: 'Target morning exit: 04:00–07:00 IST', d2: 'Do not hold to 17:30
frontend/index.html:56209:        const rows = [{ "rank": 1, "name": "Edge (Variance Risk Premium)", "trades": 49, "win": "65.3%", "stop": "34.7%", "pnl": "-$2,303", "imp
frontend/index.html:56441:        if (cls === 'exit') { tone = 'go'; title = 'EXIT NOW — close both legs'; body = 'Overnight decay captured. Never hold to the 17:30 set
frontend/index.html:56442:        else if (cls === 'hold') { tone = 'hold'; title = 'HOLD the open strangle'; body = 'Target exit 04:00–07:00 IST. Watch the <b>' + leg 
frontend/index.html:56625:          '<div class="sr-val">17:30 IST (NEVER HOLD)</div>' +
frontend/index.html:57430:      const MIN = 60000, HR = 3600000, DAY = 86400000, IST = 19800000;
frontend/index.html:58495:      function istNow() { const d = new Date(Date.now() + 19800000); return { dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() 
frontend/index.html:59365:  const ist = ms => new Date(ms + 19800000).toISOString();
frontend/index.html:60083:  const IST = ms => ms == null ? '-' : new Date(ms + 19800000).toISOString().slice(5, 16).replace('T', ' ');
frontend/index.html:60095:  const istLocal = ms => new Date(ms + 19800000).toISOString().slice(0, 16);
frontend/index.html:60096:  const istParse = v => { const t = Date.parse(String(v) + ':00Z'); return isFinite(t) ? t - 19800000 : null; };
frontend/index.html:60355:      fld('Lots per leg', inp('lots', f.lots, { t: 'num', type: 'number' }), 'One lot is 0.001 BTC. Ask me "entry 50" uses 50.') +
frontend/index.html:60378:        fld('Stop loss ($ on the position)', inp('exit.futStopUsd', f.exit.futStopUsd, { t: 'nullnum', type: 'number', step: '1', ph: 'none' }),
frontend/index.html:60592:    const dayOf = ms => new Date(ms + 19800000).toISOString().slice(0, 10), todayKey = dayOf(Date.now());
frontend/index.html:60716:      else if (k === 'today') f.validUntil = istLocal(Math.floor((now + 19800000) / 86400000) * 86400000 + 86400000 - 19800000 - 60000);
frontend/index.html:60717:      else f.validUntil = istLocal(Math.floor((now + 19800000) / 86400000) * 86400000 + (Number(k) + 1) * 86400000 - 19800000 - 60000);
frontend/index.html:60765:  const IST = ms => new Date(ms + 19800000).toISOString().slice(5, 16).replace('T', ' ');
frontend/index.html:60766:  const STRAT = { ASIA_SHORT: 'Asia short strangle 10:00', NY_SHORT: 'NY short strangle 22:30', EVE_LONG: 'Evening long straddle 17:30', PRE_LON
frontend/index.html:60773:  const MIN_MS = 60000, DAY_MS = 86400000, IST_MS = 19800000, GRACE_MS = 10 * MIN_MS;
frontend/index.html:61027:        const mk = l.mark != null ? l.mark : (l.type === 'future' ? p.spot : null), sold = l.side === 'short', pl = mk == null || l.entryPrice =
frontend/index.html:61653:        list.map(g => '<div class="alGrp"><div class="alGh"><b>' + esc(g.label) + '</b><span class="alChip">' + esc(SRC[g.source] || g.source) +
frontend/index.html:61709:  const IST = ms => new Date(ms + 19800000).toISOString().slice(5, 16).replace('T', ' ');
frontend/index.html:61762:      '<label>Size in lots (1 lot = 0.001 BTC) <span class="dim" id="ppFSize"></span><input type="number" id="ppFLots" min="1" step="1" value="1
frontend/index.html:61803:    const mcell = r => r.sellMargin == null ? '<td class="dim">-</td>' : '<td class="mg' + (r.sellOk === false ? ' neg' : '') + legMark(r.symbol
frontend/index.html:61994:        return new Date(b.at + 19800000).toISOString().slice(11, 16) + ' IST · ' + (b.direction === 'buy' ? 'bought ' : 'sold ') + btc(b.amount
frontend/index.html:62063:    const lots = Math.floor(Number(t.lots)) || 0, notional = ref ? ref * lots * 0.001 : null, pm = !S.acct || S.acct.marginMode !== 'standard', 
frontend/index.html:62081:    const lots = Math.floor(Number(t.lots)) || 0; $('ppFSize').textContent = '= ' + (lots * 0.001).toFixed(3) + ' BTC';
frontend/index.html:62090:    h += pos.length ? pos.map(x => '<div class="pp-strat"><div class="pp-strat-top"><div><div class="pp-strat-name">' + (x.lots > 0 ? 'Long ' : 
frontend/index.html:62504:      { title: 'Evening long straddle, 17:30', text: 'Stop at -10% of margin, take profit at +50%, out around 21:00.' },
frontend/index.html:62528:      { title: 'Set the size', text: '1 lot is 0.001 BTC. The card shows the position value and the estimated margin.' },
frontend/index.html:62537:  const nowDay = () => { const t = new Date(Date.now() + 19800000); const wd = t.getUTCDay(); return t.getUTCHours() < 7 ? (wd + 6) % 7 : wd; };
frontend/index.html:62985:      const hh = T.when === 'now' || !at ? new Date(Date.now() + 19800000).toISOString().slice(11, 16) : at;
frontend/index.html:63171:      const head = '<div class="at-leg"><div class="at-legh"><b style="color:' + (l.type === 'call' ? '#15803D' : '#C53030') + '">' + (l.side ==
frontend/index.html:63255:        '<span>Stoploss</span><b>' + esc(stopText(r)) + '</b>' + (later ? '<span>Days</span><b>' + esc(daysText(r.days)) + '</b><span>Repeat</sp
frontend/index.html:63312:      return '<div class="at-card"><div class="at-h">Lot size for ₹' + Number(m.capital).toLocaleString('en-IN') + '</div><div class="at-fine"
frontend/index.html:63419:    const vu = v('valid'), eod = n => Math.floor((Date.now() + 19800000) / 86400000) * 86400000 + (n + 1) * 86400000 - 19800000 - 60000;
frontend/index.html:63467:    const SLOT = { ASIA_SHORT: '10:00', NY_SHORT: '22:30', EVE_LONG: '17:30', PRE_LONG: '05:00' };
frontend/index.html:63559:        const eod = n => Math.floor((now + 19800000) / 86400000) * 86400000 + (n + 1) * 86400000 - 19800000 - 60000;
frontend/index.html:63644:      return P.defaultExitTime(at || new Date((nowMs || Date.now()) + 19800000).toISOString().slice(11, 16));
frontend/index.html:63709:        case 'time': return w.rule.entry.kind === 'window' ? extra.concat([C('22:30 to 01:30'), C('10:00 to 13:00'), C('17:30 to 20:30')]) : ext
frontend/index.html:64743:    const cv = +(p.product && p.product.contract_value) || +(p.contract_value) || 0.001;
frontend/index.html:64802:          cv: +(f.product && f.product.contract_value) || +(f.meta_data && f.meta_data.contract_value) || 0.001
frontend/index.html:65005:    const cv = 0.001;
frontend/index.html:65290:      const cv = 0.001;
frontend/index.html:65453:    if (sz) sz.textContent = (openPos.size || 5) + ' lots (' + ((openPos.size || 5) * 0.001).toFixed(3) + ' BTC)';
frontend/index.html:65674:      const isPos = pos.totalPnl > 0.001;
frontend/index.html:65675:      const isNeg = pos.totalPnl < -0.001;
frontend/index.html:65733:          '<div class="v-kpi"><span class="v-kpi-lbl">Position Size</span><span class="v-kpi-num">' + pos.size + ' lots</span><span class="v-kpi
frontend/index.html:65739:          '<div class="v-greek-box"><span class="v-greek-lbl">Net Gamma (Γ)</span><span class="v-greek-val">' + (grk.gamma || '-0.001') + '</sp
frontend/index.html:65802:      const isPos = lastTrade.pnl > 0.001;
frontend/index.html:65803:      const isNeg = lastTrade.pnl < -0.001;
frontend/index.html:66040:        const isNeg = interpPnl < -0.001;
frontend/index.html:66041:        const isPos = interpPnl > 0.001;
frontend/index.html:66228:      const cv = +(p.product && p.product.contract_value) || +(p.contract_value) || 0.001;
```
