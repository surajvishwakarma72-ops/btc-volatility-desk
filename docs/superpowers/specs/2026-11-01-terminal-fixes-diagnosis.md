# Terminal Fixes: Diagnosis for Sections 1-4 (no code changed)

Brief: `terminal_fixes_build_prompt.md`, sections 1 (API keys), 2 (accurate P&L), 3 (tick recording) and 4 (floating P&L).
Surveyed `feat/multi-asset-phase-1` on 2026-11-01. Everything below comes from reading the code. The live database could not be checked, so section 6 lists what is still unconfirmed.

## Update after step 1: the main cause

Commit 5d3d559 (2026-10-30) added a stray `}` inside the `vLivePnlTick` script block in `frontend/index.html`. A syntax error makes a browser skip the whole block, and the live site had the same error when checked on 2026-11-01. So from that commit on, the P&L card, position tracker and `/ws/desk` connection in that block did not run at all. Fixed in step 1, not yet deployed.

This changes how the findings below read. K1, K2, P1, P2 and P5 are real defects in that block, but they were not what you were seeing, because the block was not running. They become live once the fix is deployed, so K1 (sub-account shown as main) must be fixed in step 2 before or with that deploy. The floating panel (F1-F3, F5) is in a separate block and was already running.

**Second correction, found in step 3: there are two floating P&L panels.** F1-F3 below describe the newer `vGreekPnlFloating` panel, which always shows $0.00. The everyday "LIVE P&L · [READ+TRADE]" panel is a different, older one (`index.html`, `v100` `apiPoll` and `apiFresh`). It does work, but it runs in the browser: it polls every 30 seconds with no account chosen, `tick()` stops when the page is hidden, a reading older than 150 seconds becomes "Position not confirmed", and it recognises BTC symbols only. This fits the screen-off staleness in section 4 of the brief far better than the $0.00 panel does. Step 6 must cover this panel. It also already shows Delta's error reasons, so K2 applied only to the dead block.

`routes/algo.ts:222` still reads one account with `trade ?? read`. It is a display list and sends no orders, but it shows only the sub-account when both keys exist. Fix with step 6.

## Headline

The two keys are probably not what is broken. The P&L pipeline is:

- The floating P&L cannot show a real number, because the data source behind it was never connected.
- Server fills are never collected, so Session P&L has nothing to add up.
- A hard-coded trade is shown as real when fills are missing.
- The main and sub accounts overwrite each other in the browser.

## 1. API keys and Key Health

| # | Severity | Location | What is wrong | Proposed fix |
| --- | --- | --- | --- | --- |
| K1 | **High: accounts mixed** | `routes/ws-desk.ts:110`, `frontend/index.html:66366` | The server WebSocket sends the trade key's (sub) positions when a trade key exists. The browser stores them in the read-only (main) slot, so "main" shows the sub-account whenever a trade key exists. Corrected 2026-11-01: this does not flip. The browser's repeating polls are commented out (`:66123`), so it polls only at startup and on a tab switch (`:66461`, `:65591`). Read + Trade positions and all fills are therefore frozen between those moments. | Send one labelled message per account, using the account logic already correct in `watch/sources.ts:33`. Browser stores by label. |
| K2 | **High: silent nothing** | `index.html:64926,64938,64960,64972` | `r.ok ? r.json() : null`, then return. A rejected key shows no error, and the last positions stay on screen. This is exactly "silently showing nothing". | Replace with the Key Health state in K5. |
| K3 | High: silent empty | `ws-desk.ts:113-119` | Any failure returns `[]`. The browser then shows "no positions" on a live position. | Send the failure as a failure. Never turn an error into an empty list. |
| K4 | Medium: masked identity | `routes/delta.ts:222` | If no key is saved for a kind and `DELTA_API_KEY` is set, the server key answers. It answers for `kind=read` and `kind=trade` alike, so one account can appear as both. | Use the server key only when no kind was requested, and label it. |
| K5 | Medium: no health | `delta-keys.ts:65`, `delta.ts:234-245` | Only one text error is stored, and `/credentials` returns one key's status. The UI cannot show both accounts. Saving a key sets `last_ok_at` before any later use. | Return both accounts with a state: connected, auth failed, IP not whitelisted, rate-limited, stale, plus last success time. Delta's error code maps to the state. |
| K6 | Medium: not enforced | `routes/watch.ts:81`, `delta-keys.ts` | The read and trade keys sit in separate slots, and order code loads only the trade slot, which is good. But nothing checks a key's real permission on save, and `algo-service.ts:124` falls through from trade to read. That line is a balance read and is safe, but it is the same mixing pattern as K1. | A single `orderKey()` accessor as the only route to order calls, with a test that the read slot cannot reach it. |

Verified as fine: the India base URL and the signature format (`delta.ts:25-26`). `delta.ts` refreshes the outbound IP check. Server clock drift is not checked.

## 2. Accurate P&L

| # | Severity | Location | What is wrong | Proposed fix |
| --- | --- | --- | --- | --- |
| P1 | **Critical: invented numbers** | `index.html:65187-65198`, `:65203-65225` | With no fills it returns a fixed trade, commented "100% Verified", dated 31 Oct expiry with +$0.25. Partly filled trades borrow its prices through `||` defaults. `fee: closed[0].fee \|\| 0.097` turns a zero fee into a made-up one. | Delete all of it. No fills means "No closed trades". |
| P2 | **Critical: wrong account** | `index.html:65163-65172`, `:65229` | Read-only falls back to the trade account's fills, and the Read+Trade view simply calls the read-only function. Closed trades are never separated by account. | Separate by account, no fallback. |
| P3 | **High: nothing feeds it** | `routes/fills.ts:223`, `session-pnl.ts` | Nothing in the backend or frontend calls `/fills/ingest`. Unless something outside this repo does, the `fills` table stays empty and Session P&L is always $0. | New server sync of `/v2/fills` per account into `fills`. |
| P4 | High: wrong totals | `session-pnl.ts:45` | Sums every row with no user or account filter. | Filter by user and account. |
| P5 | High: truncated | `index.html:64957,64969` | Fills: first 100 only, options only, kept in `localStorage`. Grouping into trades can miss legs. | Server sync with pagination and perpetuals. |
| P6 | High: fees missing | `watch/real-tracker.ts:18,60,70` | Run P&L is `(entry - mark) x size x 0.001`: no fees, no realised part after a partial close, and closed on the last mark instead of real fills. | Rebuild from fills: realised, unrealised at exchange mark, fees including GST as charged, net. |
| P7 | Medium: no slippage | No source | Live slippage needs the mark or mid when the order was sent, which is not stored. | Store it at send time in `live-entry.ts` and `live-exit.ts`. |
| P8 | Medium: mismatch | `routes/bot.ts:51,167` | Slippage assumes lot 0.001. | Use contract value from the fill. |
| P9 | Medium: no labels | All P&L views | No source label, no reconciliation against the exchange. | Labels LIVE-MAIN, LIVE-SUB, PAPER, ALGO, BOT. Compare with Delta and warn. |
| P10 | To verify | `routes/pnl.ts:138` | `/pnl/session` has no auth check on the route itself. Whether something upstream protects it was not confirmed. | Confirm, then add the same check as `/greek`. |

Paper and algo fills already use the real book and real fee rates (`paper-broker.ts`), so they are not the problem here.

## 3. Tick recording

What exists: `real-tracker.ts` records a mark for each real position group from the 5-second watcher, so recording is already on the server and does not stop with the screen. `algo_run_marks` stores only time, net and spot.

What is missing against the brief: mark per leg, realised P&L, fees, Greeks, the account on each row, and peak and max-drawdown markers. Marks are skipped if any leg's mark is missing, which leaves unflagged gaps.

**"Every tick" needs your decision.** The watcher polls every 5 to 8 seconds, so it is not literally tick by tick. True ticks need Delta's private WebSocket, whose rules I could not confirm because the docs page was cut off. At a 5-second rate, one trade open for a day is about 17,000 rows, which is manageable. Recommendation: extend the existing server recording at 5 seconds now, and move to private WebSocket once the limits are confirmed.

## 4. Floating P&L

| # | Severity | Location | What is wrong | Proposed fix |
| --- | --- | --- | --- | --- |
| F1 | **Critical: always $0** | `routes/pnl.ts:100`, `:35` | The panel calls `/pnl/greek`, which reads positions through a provider. `setPositionLookupProvider` is never called in production, so every quantity is 0 and every figure shows $0.00 with a 200 response. | Serve the panel from server account state. |
| F2 | High: wrong symbol | `index.html:66897-66935` | The symbol is guessed from the page. The fallback is the first ticker in the list, which can be any contract. One symbol also cannot describe a two-leg strangle. | Report per position group, per account. |
| F3 | High: one view only | `index.html:65130-65137` | `getAnyOpenPosition` returns main first and hides sub. | One row per account, labelled. |
| F4 | Medium: dead code | `index.html:65347-65348` | The old pill has `return;` on its first line, followed by its whole body and sample figures ("5 lots", "$0.825"). | Remove. |
| F5 | Medium: no resync | `index.html:67041`, module has no `visibilitychange` | A 5-second browser timer with no resync on wake. | Resync on wake and reconnect, using server state with `server_ts`. |
| F6 | To locate | `index.html:21421`, `:21934` | The "last update 13 seconds ago" text. The floating panel has no time label of its own, so it probably comes from `age` or the `ago` helper in another panel. I need to see which one you mean. | Show age from the server's timestamp. |

The WebSocket already reconnects with backoff (`:66417`), so heartbeat is the only piece left to check.

## 5. Proposed order, behind a feature flag where the live algo is touched

1. **Stop false numbers first** (P1, P2, F4). Small frontend change with no risk to trading.
2. **Server account state** (K1, K3, K4, K5): one poller per account from `watch/sources.ts`, holding positions, wallet, health and `server_ts`, with labelled WebSocket messages.
3. **Key Health UI** (K2, K5), plus the order-key accessor (K6).
4. **Fills sync and P&L from fills** (P3-P6, P8, P9), with reconciliation.
5. **Recording upgrade** (section 3), then peak and drawdown markers.
6. **Floating P&L on server state** (F1-F3, F5).
7. **Slippage capture** (P7). This touches the order path, so it goes behind a flag.

Each step is checked with read-only keys or paper. No orders are placed in testing.

## 6. Not confirmed

- **Real state of both keys.** The stored `last_error`, whether fills exist, and whether `DELTA_API_KEY` is set on the VM were not read. The live read was blocked. If a key shows an auth or IP error, that is a further cause on top of those above.
- Exact Delta field names for fills (fee, GST, realised P&L). These must be checked against the docs and one real response before step 4.
- Delta's private WebSocket rules.
