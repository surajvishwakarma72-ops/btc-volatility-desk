# Speed + Paper Trade Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the terminal's background load and make every Paper Trade tab keep updating with honest numbers.

**Architecture:** On the server, the paper board computes margin for one expiry and caches it, and `/account` can carry the P&L block so the account is computed once per poll. In the browser, the paper page fetches only what the open tab needs and each part updates on its own. A dev-only meter measures main-thread load, then the fastest DOM-polling timers are moved onto the existing `desk80` tick, gated by page and visibility, or removed.

**Tech Stack:** Fastify + TypeScript + vitest/PGlite (backend); one plain-JS `frontend/index.html` built by Vite.

**Spec:** `docs/superpowers/specs/2026-11-02-speed-and-paper-design.md`

## Global Constraints

- Never place, change or cancel a real order. Paper only; do not touch live order code (`routes/delta.ts`, bot/algo order paths).
- Alerts, shock alerts, beeps, algo/bot watchers, price feeds and voice must keep running when their page is hidden or the screen is off.
- Server is a 1 GB VM: any cache must be bounded (at most 8 entries per account).
- `cd backend && npm test` must stay green.
- No feature flag. Each task is its own commit so it can be reverted alone.
- Deploying to `suraj-voldesk.duckdns.org` needs the owner's yes in chat first.

## Review Focus

1. **No `expiry`, or an unknown one, on `/board`:** fall back to the first expiry and compute margin for that one only. Test in Task 1.
2. **Margin shown right after a trade:** the board cache must be cleared by any order, strategy, close, reset or margin-mode change, or the chain shows pre-trade margin. Test in Task 1.
3. **Screen off:** line ~20213 emits `desk80` `visible {hidden:true}` artificially. Gated timers must not swallow must-keep work. Manual check in Task 6.
4. **Login expires mid-poll:** with `allSettled`, a 401 on any part must still show the login box, not stale numbers forever. Manual check in Task 3.
5. **Tab switched while a fetch is in flight:** a late result for the old tab must not redraw over the new tab. Manual check in Task 3.

---

### Task 1: Board margin for one expiry, cached

**Files:**
- Modify: `backend/src/services/paper/paper-terminal.ts:1138-1158` (`boardWithMargin`) and every state-changing method (order placement, strategy open/close/stops, `reset`, margin mode, leverage)
- Modify: `backend/src/routes/paper.ts:58-81`
- Test: `backend/src/services/paper/paper-terminal.test.ts`

**Interfaces:**
- Produces: `boardWithMargin(lots: number, expiry?: number | null, maxAgeMs = 3_000): Promise<{ snap; rows; mode; available; expiry: number | null }>`. `rows` contains only rows of the resolved expiry (`expiry` if it is in `snap.expiries`, else `snap.expiries[0] ?? null`). Private `boardCache: Map<string, { at: number; out }>` keyed `` `${expiry}|${lots}|${mode}` ``, TTL 3000 ms, at most 8 entries (drop the oldest), cleared by `private dropBoardCache(): void` from every state-changing method.

- [ ] **Step 1: Write the failing tests.** Add a second expiry to the scripted market (an `mk.twoExpiries` flag that adds a put row at `EXP2 = EXP + 86_400_000` plus its instrument), then:

```ts
describe('board margin', () => {
  it('computes margin only for the asked expiry', async () => {
    mk.twoExpiries = true;
    const b = await t.boardWithMargin(100, EXP2);
    expect(b.expiry).toBe(EXP2);
    expect(b.rows.every((r) => r.expiryMs === EXP2)).toBe(true);
  });
  it('falls back to the first expiry when none or an unknown one is asked', async () => {
    mk.twoExpiries = true;
    expect((await t.boardWithMargin(100)).expiry).toBe(EXP);
    expect((await t.boardWithMargin(100, 123)).expiry).toBe(EXP);
  });
  it('serves a repeat call from cache and drops the cache after a trade', async () => {
    const spy = vi.spyOn(t as any, 'view');
    await t.boardWithMargin(100, EXP); const n = spy.mock.calls.length;
    await t.boardWithMargin(100, EXP); expect(spy.mock.calls.length).toBe(n);
    await t.placeOrder({ symbol: CALL, side: 'sell', type: 'market', lots: 10 });
    await t.boardWithMargin(100, EXP); expect(spy.mock.calls.length).toBeGreaterThan(n);
  });
});
```

Reset `mk.twoExpiries = false` in `beforeEach`. Use the real order method name from the file if it isn't `placeOrder`.

- [ ] **Step 2: Run and see them fail.** `cd backend && npx vitest run src/services/paper/paper-terminal.test.ts -t "board margin"`. Expected: FAIL (rows from both expiries, `expiry` undefined, no cache).
- [ ] **Step 3: Implement.** Resolve the expiry first and filter `snap.rows` before the margin loop. Add the cache and `dropBoardCache()`, and call it at the end of every state-changing method. Change the route to pass `Number(query.expiry) || null` and use the returned `expiry` instead of resolving it again.
- [ ] **Step 4: Run all backend tests.** `cd backend && npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `git add backend/src/services/paper backend/src/routes/paper.ts && git commit -m "perf(paper): board margin for the asked expiry only, cached 3 s"`

---

### Task 2: One account computation per poll; honest open P&L

**Files:**
- Modify: `backend/src/services/paper/paper-terminal.ts` (`account()` ~570, `pnl()` ~1087)
- Modify: `backend/src/routes/paper.ts:40-56`
- Test: `backend/src/services/paper/paper-terminal.test.ts`

**Interfaces:**
- Produces: `account()` adds `perpInfo: { contractValue, maxLeverage, tick, takerRate, makerRate } | null`. `pnl(acct?: Awaited<ReturnType<PaperTerminal['account']>>)` reuses the given account instead of calling `account()`. `GET /account?withPnl=1` returns `{ success, ...account, pnl }`. `/pnl` stays for old callers. Each side of `pnl()` gains `openFees: number`. `openPnl` becomes `number | null`, and is `null` when any held position has `unrealized == null`.
- Futures `openFees`: walk perp fills newest to oldest, starting from the current signed lots `L`. For each fill, add its `fee` and subtract its signed lots (`buy` +, `sell` −) from `L`. Stop when `L` reaches 0. Futures `openPnl = Σ unrealized − openFees`.
- Options side: `openFees = 0`. The frontend already uses strategy `netPnl`, which includes fees.

- [ ] **Step 1: Write the failing tests.**

```ts
describe('paper pnl', () => {
  it('futures open pnl is unrealised minus the fees of the open position', async () => {
    const o = await t.placeOrder({ symbol: 'BTCUSD', side: 'buy', type: 'market', lots: 100 });
    mk.px = 80_500;
    const p = await t.pnl(), a = await t.account();
    const upnl = a.positions.find((x: any) => x.symbol === 'BTCUSD')!.unrealized!;
    expect(p.futures.openFees).toBeCloseTo(o.order.fee, 6);
    expect(p.futures.openPnl).toBeCloseTo(upnl - o.order.fee, 6);
  });
  it('open pnl is null, not zero, when a mark is missing', async () => {
    await t.placeOrder({ symbol: CALL, side: 'buy', type: 'market', lots: 10 });
    mk.dropCall = true;   // snapshot() leaves the call row out, so it has no quote
    const p = await t.pnl();
    expect(p.options.openPnl).toBeNull();
    expect(p.options.openKnown).toBe(false);
  });
  it('pnl reuses a given account', async () => {
    const a = await t.account(); const spy = vi.spyOn(t, 'account');
    await t.pnl(a); expect(spy).not.toHaveBeenCalled();
  });
  it('account carries perp info', async () => {
    expect((await t.account()).perpInfo?.maxLeverage).toBe(100);
  });
});
```

Reset `mk.dropCall = false` in `beforeEach`. Match the real order-result shape (`o.order.fee`) to the file.

- [ ] **Step 2: Run and see them fail.** `npx vitest run src/services/paper/paper-terminal.test.ts -t "paper pnl"`. Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces. Route: in `/account`, when `withPnl=1`, compute `const a = await term.account(); return { success: true, ...a, pnl: await term.pnl(a) }`.
- [ ] **Step 4: Run all backend tests.** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit.** `git commit -am "fix(paper): futures open P&L net of fees, null when unpriced, account computed once"`

---

### Task 3: Paper page fetches per tab and updates part by part

**Files:**
- Modify: `frontend/index.html` paper module (~61945–62507): `refresh`, `drawAll`, `setTab`, `renderPnl`, `renderFutPrev`, `renderFut`, `enter`

**Interfaces:**
- Consumes: `/account?withPnl=1` (Task 2: `pnl`, `perpInfo`, `perp`), `/board?expiry=&lots=` (Task 1), `/strategies`.
- Produces in the module: `NEEDS = { over: ['acct', 'strat'], opt: ['acct', 'board', 'strat'], fut: ['acct'], hist: ['acct', 'strat'] }`; `S.part = { acct: { at, err }, board: {…}, strat: {…} }`; `S.gen`, a counter bumped by `setTab`.

- [ ] **Step 1: `refresh()`**. Fetch only `NEEDS[S.tab]` with `Promise.allSettled`. `acct` is `/account?withPnl=1`, which sets `S.acct` and `S.pnl` from one response. For each part: on success, store the data and set `S.part[k] = { at: Date.now(), err: null }`; on failure, keep the old data and set `err`. If any part fails with `status === 401`, clear `S.acct` so the login box shows. Before drawing, compare the generation captured at the start with `S.gen`; if they differ, drop the result (Review Focus 5). `loadFlow` keeps its 60 s rule, but only on `opt`.
- [ ] **Step 2: Draw the open tab only.** `drawAll()` always runs `ppNav`, `renderLogin` and `renderHead`, then only that tab's renderers: `over` → `renderPnl`, `renderStrats`; `opt` → `renderBoard`, `updateLegQuotes`, `renderStrats`, the builder; `fut` → `renderFut`; `hist` → `renderClosed`, `renderAcct`. `setTab` bumps `S.gen`, draws, and calls `refresh()` straight away. Poll intervals: 3000 ms, except `hist` at 15000 ms.
- [ ] **Step 3: Stale note.** For a part with `err`, show `<span class="pp-note warn">stale · {seconds}s · {err}</span>` in `#ppHead`.
- [ ] **Step 4: Honest numbers.** `renderPnl`: when `P.options.openPnl` or `P.futures.openPnl` is `null` (and for options, no strategy `netPnl` either), show `no price` instead of a dollar figure, and show `-` for the total. Futures come from `S.acct.perp` and `S.acct.perpInfo` instead of `S.board.perp`/`perpInfo`. `renderFutPrev`: delete the `90.3` estimate. Show position value only, and the margin line only from `p.marginRequired` once the preview returns. While waiting, show `margin: checking…`.
- [ ] **Step 5: Build.** `cd frontend && npm run build`. Expected: build succeeds.
- [ ] **Step 6: Check by hand** on a local or approved deploy, paper account only:
  - Each tab loads, and the Network tab shows only that tab's calls.
  - Blocking `/api/v1/paper/strategies` in DevTools leaves Futures updating, and Overview shows a stale note.
  - Removing `desk_jwt` mid-poll shows the login box.
  - Clicking Futures straight after Options draws no chain over it.
  - A paper futures buy shows open P&L below unrealised by the fee.
- [ ] **Step 7: Commit.** `git commit -am "fix(paper): per-tab polling, independent parts, no fake \$0, server margin for futures"`

---

### Task 4: Dev-only performance meter

**Files:**
- Modify: `frontend/index.html`. Add a new `<script data-module="perfmeter">` as the **first** script in the document, before the v80 bus at ~19776.

**Interfaces:**
- Produces: `window.perfMeter = { report(): { busyMsPerMin: number, liveIntervals: number, top: Array<{ site: string, fires: number, ms: number }> } }`. It is active only when `localStorage.perf_meter === '1'`; otherwise the script returns at once and changes nothing.

- [ ] **Step 1: Implement.** When active, wrap `setInterval` and `clearInterval`. Record each interval's call site from the first app frame of `new Error().stack`, and count fires and total callback ms per site. A `PerformanceObserver({ type: 'longtask', buffered: true })` adds up long-task duration. `report()` gives busy ms per minute since load, the live interval count, and the top 15 sites by ms.
- [ ] **Step 2: Build and take the BEFORE reading.** Set `localStorage.perf_meter = '1'` and reload. Spend 2 minutes on each of Desk, Paper and P&L, then run `copy(JSON.stringify(perfMeter.report()))`. Save it to `docs/superpowers/reports/2026-11-02-perf-before.json`.
- [ ] **Step 3: Commit.** `git add frontend/index.html docs/superpowers/reports && git commit -m "chore: dev-only perf meter + baseline reading"`

---

### Task 5: Page-aware tick helper on the bus

**Files:**
- Modify: `frontend/index.html` v80 bus (~19779–19799), and `show(p)` (~32741) to emit the page.

**Interfaces:**
- Produces: `desk80.emit('page', { page })` from `show(p)`. `desk80.every(ms: number, fn: (now: number) => void, opt?: { page?: string | string[]; whenHidden?: boolean }): () => void`. It runs on the 1 s tick when `ms` has passed since the last run, `!document.hidden` (unless `whenHidden`), and `document.body.dataset.page` is in `opt.page` (when given). When the page becomes current again, it runs once immediately. It returns an unsubscribe function. `fn` errors are logged with `console.warn('desk80.every', …)`, never swallowed.

- [ ] **Step 1: Implement** `every` inside the bus IIFE, and add the `page` emit to `show`.
- [ ] **Step 2: Check in the console:** `const off = desk80.every(2000, () => console.log('x'), { page: 'pgPaper' })`. It logs every ~2 s on Paper, and nothing on Desk. `off()` stops it.
- [ ] **Step 3: Commit.** `git commit -am "feat: desk80.every — page- and visibility-aware periodic work"`

---

### Task 6: Move the fast timers (batch by batch)

**Files:**
- Modify: `frontend/index.html` at the fast `setInterval` sites (≤ 2000 ms). The list from the 2 Nov audit is at lines ~20324, 25569, 26610, 27506, 28141, 31338, 31466, 31495, 31557, 32427, 32616, 34294, 34490, 34544, 34585, 34599, 35513, 41221, 43515, 44209, 44221, 44558, 45802, 45822, 45839, 50907, 51072, 52322, 52367, 55216, 59284, 61493, 61799, 61923, 61924. Re-grep, because the lines move: `grep -n -E "setInterval\(.{0,80}, ?(500|800|1000|1200|1500|2000)\)" frontend/index.html`.
- Create: `docs/superpowers/reports/2026-11-02-timers.md`, a table of site, what it does, group, action.

**Interfaces:**
- Consumes: `desk80.every` (Task 5), `perfMeter.report()` (Task 4).

**Rules for each site** (log the decision in the report table):
- **Keep:** anything that alerts, beeps, notifies, watches algo/bot/positions, or feeds prices or voice (for example 32427 `alerts`, 61923/61924 alarm poll and paint, 20324 cooldown). Leave the code alone.
- **Page work:** a redraw or poll for one page becomes `desk80.every(sameMs, fn, { page: '<pgId>' })`. Delete any `if (!D.hidden …)` guards it already had.
- **DOM repair** (names like `sweep`, `hook`, `mount`, `fix`, `stack`, `place`, `alignScales`, `watch`): run it on a real trigger instead, such as the `page` / `tf` / `theme` / `visible` bus events, `resize`, a `ResizeObserver`, or a `MutationObserver` on the one container it repairs. If it only needs to succeed once, stop after it does. If two sites fight over the same element, keep the newer one and delete the older, and say which in the report.

- [ ] **Step 1: Batch A**, the ≤ 800 ms sites and every DOM-repair site. Change them, run `cd frontend && npm run build`, and click through Desk, Flow, Events, Paper, Algo, Bot and P&L. Each page must look and behave as before (chart crosshair sync, candle size box, split handles, toasts not overlapping).
- [ ] **Step 2: Re-measure** as in Task 4 Step 2 and save `perf-after-A.json`. Commit: `git commit -am "perf: DOM-repair loops run on real triggers, not timers"`
- [ ] **Step 3: Batch B**, the 1–2 s page-work sites onto `desk80.every`. Build, click through, re-measure (`perf-after-B.json`), commit `"perf: page redraws run only while their page is open"`.
- [ ] **Step 4: Stop rule.** If batch B cut `busyMsPerMin` by less than 10 % compared with A, stop. Otherwise continue with the next-hottest sites in `report().top`, one batch per commit.
- [ ] **Step 5: Screen-off check** (Review Focus 3). Set one paper price alert that will trigger, lock the screen for 5 minutes, and unlock. The alert fired, and Desk and Paper resume within a second.

---

### Task 7: Finish

- [ ] **Step 1:** `cd backend && npm test`. All pass. `cd frontend && npm run build`. Succeeds.
- [ ] **Step 2:** Write the summary in `docs/superpowers/reports/2026-11-02-speed-and-paper.md`: before and after `busyMsPerMin` for Desk, Paper and P&L; the number of timers removed or moved; the files touched; how to test; known limits.
- [ ] **Step 3:** Ask the owner before deploying. After a yes, deploy as `docs/OPERATIONS_HANDOFF.md` describes. Then check `curl https://suraj-voldesk.duckdns.org/health` and that every Paper tab updates for 10 minutes.
