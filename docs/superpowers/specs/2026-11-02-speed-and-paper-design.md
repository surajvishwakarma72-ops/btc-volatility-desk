# Job 1 — Speed + Paper Trade page

Date: 2 Nov 2026 · Status: waiting for owner approval

## Why

The terminal lags, and the Paper Trade page (Overview, Futures and the other tabs) freezes or shows wrong
numbers. Lag makes every later fix in `terminal_fixes_build_prompt.md` hard to test, so it goes first.
Paper is in the same job because most of its trouble comes from the same cause: too much work repeated
every few seconds.

## What was found (from reading the code, 2 Nov)

Frontend (`frontend/index.html`, ~69,400 lines, 75 patch layers):
- 202 `setInterval` calls but only 50 `clearInterval`. About 40 run every 0.5–2 s. Most of them re-find
  elements, re-attach chart hooks or re-align scales (for example `setInterval(stack, 500)` at ~35513,
  `sweep` 1–2 s at ~34490/34585, `mount` at ~52322/52367, `fix` at ~43515). Many run while their page is hidden.
- There is already a shared 1-second tick (`window.desk80`, ~19780) that modules are meant to use, but many
  don't.
- 1,102 empty `catch` blocks, so a failing panel goes blank without saying why.

Paper page (`frontend/index.html` ~61945–62507, `backend/src/routes/paper.ts`,
`backend/src/services/paper/paper-terminal.ts`):
1. `boardWithMargin` (paper-terminal.ts:1138) runs a full margin calculation for **every option on every
   expiry** every 3 s, and the route then keeps only one expiry.
2. The Futures tab gets its BTCUSD quote by downloading the whole option board.
3. `refresh()` uses `Promise.all` over `/account`, `/board`, `/strategies`, `/pnl`: one slow or failed call
   means nothing updates.
4. `drawAll()` redraws every tab every 3 s, including hidden tabs and the full chain.
5. `/pnl` calls `account()` again, so the account is computed twice per poll.
6. Futures open P&L excludes fees; options open P&L (strategy `netPnl`) includes them. Overview adds the two.
7. A missing mark is counted as $0 P&L (`p.unrealized ?? 0`); the server's `openKnown` flag is ignored.
8. Portfolio-margin futures margin is shown as value ÷ 90.3, a fixed guess.

## Goals

- The terminal feels responsive: no visible stutter when switching pages, scrolling the chain or
  dragging the chart.
- Paper Overview, Options, Futures and History keep updating, and one failing request never freezes the
  others.
- Paper numbers are honest: fees treated the same for options and futures; "no price" instead of $0;
  margin from the server, not a fixed divisor.

## Non-goals (later jobs)

- Resizable chart and indicator heights (job 2).
- API keys, live P&L, tick recording, delta rule, time locks, IV sessions, alerts, theme (the fix file's list).
- Rewriting or splitting `index.html`.

## Anti-goals (a failure even if it is "faster")

- Any alert, shock alert, beep, algo watcher or price feed that stops working while its page is hidden or
  the screen is off. These must keep running.
- Any change that can send a real order. Paper only; never touch the live order path.
- Any panel that used to work and now shows nothing.

## The plan

### A. Measure first
Add a small dev-only meter (off by default, switched on from the browser console) that reports, per minute:
main-thread busy time from long tasks, the number of live intervals, and which ones fired most. Take a
before reading on Desk, Paper and P&L pages, and the same after. The result goes in the summary.

### B. Frontend timers
Make a list of every interval faster than 5 s and sort each into one of three groups:
- **Must keep running** (alerts, shock alerts, algo or bot watchers, feeds, the voice and audio paths):
  leave alone.
- **Page work** (redraws for one page): run only while that page is open and the tab is visible, using
  `desk80`'s tick plus the current `data-page`. Catch up once when the page is opened again.
- **DOM repair loops** (re-find, re-hook, re-mount, re-align): replace them with one run on page change,
  resize or chart creation, or stop polling once the hook succeeds. Where a loop is clearly a leftover
  patch fighting another patch, remove the weaker one.

Work through the fastest and widest-reaching first, and re-measure after each batch. Stop when the gain
levels off; don't try to fix all 202.

### C. Paper page, server
- Board margin for the **requested expiry only**. Cache the result for each account, expiry and lot
  count for about 3 s, so two tabs or two users don't repeat it.
- A light endpoint (or a field on `/account`) for the BTCUSD quote and perp info, so Futures doesn't
  need the board.
- `/pnl` reuses the account it was just given, or `/account` returns the P&L block, so the account isn't
  computed twice.
- Futures open P&L net of fees, like options. `openPnl` becomes `null` when any mark is missing, with
  `openKnown` passed through.

### D. Paper page, frontend
- `Promise.allSettled`: each part updates on its own, and a failed part keeps its last value with a small
  "stale · reason" note.
- Only fetch and redraw what the open tab needs. Overview needs P&L and strategies; Options needs the board
  and strategies; Futures needs the quote and account; History needs the account plus the closed list,
  slower.
- Show "no price" instead of $0 when a mark is missing.
- Futures margin comes from the server's `/preview` `marginRequired`. Drop the 90.3 line, or label it
  "rough" until the preview comes back.

## Constraints

- Server is a 1 GB Oracle VM (see the recent build commit). Keep any server-side caches small.
- Existing tests: `backend/src/routes/paper.test.ts` and `services/paper/*.test.ts` must stay green. Add tests
  for single-expiry board margin, fee-inclusive futures P&L, and a null mark giving null P&L.
- Never place, change or cancel a real order while testing. Use paper only.

## Done when

- The before and after meter readings show a clear drop in main-thread busy time on Desk and Paper.
- On Paper, every tab keeps updating for 10 minutes, and blocking `/pnl` in DevTools leaves Futures and
  Options updating.
- A paper futures trade's open P&L includes its fee; a missing mark shows "no price".
- All alerts and the algo watcher still fire with the screen off (check with one paper alert).

## Calls I made (owner can overrule)

- No feature flag. The changes are many small edits, not one switch; `git revert` of the job's commits is
  the way back. Live order code is not touched.
- Use the existing `desk80` tick rather than a new scheduler.
- Stop the timer work when the gain levels off rather than going through all 202.
- The meter is dev-only and off by default.

## Left to the builder

- The exact grouping of each timer, and whether the futures quote is a new route or a field on `/account`.
- Cache details, and the wording of the stale notes.
