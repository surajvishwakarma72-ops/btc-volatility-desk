# Job 1 — Speed + Paper Trade page: summary

Branch `perf/speed-and-paper` (from `feat/multi-asset-phase-1` at b8f5a84). Not deployed.

## What changed

**Paper, server** (`backend/src/services/paper/paper-terminal.ts`, `backend/src/routes/paper.ts`)
- The board computes sell-margin only for the asked expiry (it did every expiry), cached 3 s per expiry, lot count and
  mode, and cleared on every fill, settlement, leverage, margin-mode or reset.
- `GET /account?withPnl=1` returns the account and its P&L from one account read (the page used to compute it twice).
- `account()` carries `perpInfo`, so Futures no longer needs the option board.
- P&L: `openPnl` is `null` (not $0) when a mark is missing. New `openFees` and `openNet` (futures open P&L after the fees
  of the open position). `openPnl` itself stays before fees, because the closed totals already include entry fees.

**Paper, page** (`frontend/index.html` paper module)
- Each tab fetches only what it shows (Futures: the account only; Options: account, board and strategies; History: every 15 s).
- `Promise.allSettled`: a failed part keeps its last value with a "stale · Ns · reason" note; the rest keeps updating.
- A late answer for a tab already left is not drawn.
- Overview shows "no price" instead of $0, futures after fees. The ÷90.3 margin guess is gone: portfolio margin
  shows "checking…" until the server preview answers.

**Whole terminal**
- Fixed a fight between two scripts over the Desk section order. Every 3 s every Desk section, charts included, was
  re-appended, on every page.
- Several per-second loops now skip hidden pages and write to the page only on a change. See `2026-11-02-timers.md`.
- New: `desk80.onOpenPage(el)` and `desk80.every(ms, fn, {page})`. A dev-only meter (`localStorage.perf_meter = '1'`)
  and `tools/perf/measure.mjs`, a headless before/after harness.

## Measured (headless Chrome, no backend, outside network blocked, ms of main-thread work per minute)

| Page | Before (2 runs) | After (2 runs) |
|---|---|---|
| Desk | 3886 / 3923 | 3947 / 4021 |
| Paper | 3893 / 4111 | 4358 / 4344 |
| P&L | 3523 / 3663 | 3922 / 3790 |

With no data there is no gain. Paper and P&L read about 5% higher, likely the meter's own extra wrapping, which is on only
in these runs. With live network the after-runs were about 8% lower, but those runs vary by ±15%.
**Conclusion: the idle timers are not what makes the terminal lag.** The lag most likely comes from work done when live data
arrives (socket messages, chart redraws). That needs a recording in the real browser with real data. See Next.

## Tests

- Backend: 1578 pass, 5 fail. The same 5 failed before this job (auth-login ×2, audit-logger ×2, ask/answer ×1), and none
  are in paper code. 8 new paper tests.
- Type check clean. Frontend builds, and all 146 inline scripts parse.

## Not checked (needs the owner, after an approved deploy)

1. Each Paper tab updates for 10 minutes. Blocking `/api/v1/paper/strategies` leaves Futures updating.
2. A paper futures buy shows open P&L below unrealised by its fee.
3. Lock the screen for 5 minutes with one paper alert armed: it fires, and Desk and Paper resume.
4. The Desk looks the same (section order unchanged on screen).

## Next

Record 60 s of Chrome DevTools → Performance on the live Desk with real data and look at what runs per socket message.
That is where the lag is.
