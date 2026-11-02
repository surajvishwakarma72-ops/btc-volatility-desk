# Desk Chart Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Desk shows only the chart panel, full screen in the CoinGlass style. Every other Desk section sits in a Tools ▾ drop-down, and the candles and every lane can be resized with drag dividers that are saved per device and view.

**Architecture:** `arrange()` keeps only the chart block on the Desk and moves the other sections into a Tools panel inside `#chartp`. A small store (`window.dkHeights`) holds each lane's share of the chart panel per profile, and `v133.fit()`, the single owner of heights, uses those shares when present. Dividers only change shares and call `fit()`.

**Tech Stack:** One plain-JS `frontend/index.html` (Vite build). Checks run in headless Chrome through `tools/perf/run-page.mjs` (CDP).

**Spec:** `docs/superpowers/specs/2026-11-03-desk-chart-page-design.md`

## Global Constraints

- Nothing on `#chartp` is deleted or redesigned. The before/after control inventory must match.
- One owner of heights: `v133.fit()` (~47829). No other code sets lane or candle heights.
- Minimums: candles 180 px on a phone, 240 px on desktop; any lane 48 px. A phone is `innerWidth <= 760`.
- Profiles are `phone|normal`, `phone|full`, `desk|normal` and `desk|full`, where full means `body.gfs`. localStorage key `desk_heights_v1`.
- Sections moved into Tools keep their ids, feeds and alerts. Only their drawing may pause while hidden.
- Don't commit `frontend/dist`. Never place, change or cancel a real order.
- Deploy only after the owner says yes.

## Review Focus

1. **Lane switched on after the user saved shares:** it gets its default share and the others keep their proportions. Test in Task 3.
2. **Saved shares that no longer fit** (smaller screen, more lanes): enforce the minimums by scaling lanes down, never below 48 px, and keep candles at or above the minimum. Test in Task 3.
3. **Phone touch on a divider:** the page must not scroll (`scrollY` unchanged), and a vertical swipe on the chart must not move a divider. Test in Task 4.
4. **Tools panel open while switching pages or entering full screen:** it closes and nothing is left floating. Test in Task 2.
5. **Two height owners again** (blinking): no height or max-height change on any lane for 60 s without input. Test in Task 5.

---

### Task 1: Headless harness for viewport, touch and inventory

**Files:**
- Modify: `tools/perf/run-page.mjs`
- Create: `tools/perf/inventory.mjs` (a check script), `docs/superpowers/reports/2026-11-03-chart-inventory-before.json`

**Interfaces:**
- Produces: `run-page.mjs` accepts the env var `VIEWPORT=WxH[,mobile]` (applied with `Emulation.setDeviceMetricsOverride`, and `Emulation.setTouchEmulationEnabled` when mobile) and `PAGE_ON=pgDesk`. It passes `{ ev, sleep, click, cdp(method, params) }` to the check. `inventory.mjs` returns a sorted array of `"<tag> <id-or-first-class> :: <aria-label|title|text, 60 chars>"` for every visible button/input/select/label/[role=button|tab] inside `#chartp` (the logic of `.superpowers/sdd/inv-chart.mjs` without the positions).

- [ ] **Step 1:** Add the viewport, touch and `cdp` support to `run-page.mjs`.
- [ ] **Step 2:** Run the inventory on the **current** page at `1440x900` and at `390x844,mobile`. Save both arrays to `…inventory-before.json` as `{ desktop: [...], phone: [...] }`. Expected: at least 40 desktop entries, including `#v132IndBtn`, `#emBtn`, `.zm-b`, `.dw-b` and `#gRange`.
- [ ] **Step 3: Commit.** `"test: headless viewport/touch harness and chart-panel inventory"`

---

### Task 2: The Desk is the chart; Tools ▾ holds the rest

**Files:**
- Modify: `frontend/index.html`. `arrange()` in `<script id="v105_22Arrange">` (~21252); `#gTop .r` gets the Tools button; styles near the other `#chartp` rules.
- Create: `tools/perf/check-desk.mjs`

**Interfaces:**
- Produces:
  - `#dkToolsBtn` (button in `#gTop .r`, text `Tools ▾`, `aria-expanded`).
  - `#dkTools` (panel, a child of `#chartp`, `position:absolute`, top = bottom of `#gTop`, `max-height: 72%`, scrolls itself, `z-index` above the lanes and below modals, `hidden` when closed) holding `#dkToolsIn`.
  - `window.dkTools = { open(): void, close(): void, isOpen(): boolean }`.
- Order inside `#dkToolsIn`: `#v89Rail`, `#v104Lead`, `#volRow`, `#side2`, `#flowRow`, `#v110PnlHd`, `#v18Trade` (skip missing ones and ones with `data-v134`).
- `#pgDesk .desk` keeps only `#v22Top`. `#v22Side` is hidden when empty.

- [ ] **Step 1: Write `check-desk.mjs`.** At desktop and at phone viewport it returns:
  - `deskKids`: ids of `#pgDesk .desk` children; expected `['v22Top']`.
  - `toolsKids`: ids in `#dkToolsIn`; expected the list above minus any missing.
  - `openShown`: after `dkTools.open()`, `#dkTools` is visible and `#v18Trade` has a client rect.
  - `closedOnPage`: after open then clicking `button[data-page="pgPaper"]`, `dkTools.isOpen() === false`.
  - `closedOnFs`: after open then adding `body.gfs`, closed.
  - `escCloses`: true when Esc closes it.
  - `pill`: the floating P&L pill (the element styled by the `vFpnl*` rules; the builder confirms its id) is still attached to the page and is not inside `#dkTools`.
  - `inventory`: inventory.mjs's result.
- [ ] **Step 2: Run it on the current page.** `VIEWPORT=1440x900 node tools/perf/run-page.mjs frontend/index.html frontend/public tools/perf/check-desk.mjs`. Expected: FAIL (deskKids has 8 entries, no `dkTools`).
- [ ] **Step 3: Implement.**
  - `arrange()` builds `#dkTools`/`#dkToolsIn` once, appends the sections there in that order (only when the order differs, as today), and keeps `#v22Top` alone on the desk.
  - Open, close and Esc handling. Close on the bus `page` event and when `body.gfs` toggles (MutationObserver on the body class).
  - The existing MutationObserver on the desk must not loop (re-run `check-who.mjs`'s logic: zero desk re-appends in 20 s).
- [ ] **Step 4: Run it again at both viewports.** Expected: every value as listed. The `inventory` equals `…inventory-before.json` plus exactly one new entry, `button #dkToolsBtn`.
- [ ] **Step 5: Build and parse.** `cd frontend && npm run build` succeeds. The parse check (as in job 1) gives 0 errors.
- [ ] **Step 6: Commit.** `"feat(desk): chart-only Desk; other sections in a Tools panel"`

---

### Task 3: Height shares store, used by `v133.fit()`

**Files:**
- Modify: `frontend/index.html`. A new `<script data-module="dkHeights">` placed before the v133 script; `fit()` at ~47829–47866.
- Create: `tools/perf/check-heights.mjs`

**Interfaces:**
- Produces `window.dkHeights`:
  - `profile(): 'phone|normal'|'phone|full'|'desk|normal'|'desk|full'`
  - `get(p = profile()): Record<laneId, number> | null`: a share is a fraction of the chart panel height `ph`. Candles are implicit (`1 − Σ`). ADX uses the key `'paAdxBox'`.
  - `set(map: Record<laneId, number>, p = profile()): void`: saves to `desk_heights_v1`, then calls `W.v133.fit()`.
  - `reset(p?: string): void`: clears one profile (all when called with no argument), then calls fit.
- Consumes in `fit()`: when `dkHeights.get()` is not null, each shown lane's height is `round(share × ph)`. A shown lane with no saved share gets its current default height, and the saved lanes are scaled down by the same factor so the candles keep their space. Then the minimums apply: lanes at least 48 px; if the candles fall under 180/240 px, scale all lanes down proportionally (none below 48). The ADX share feeds `W.__v133Adx`. With no saved shares, `fit()` behaves exactly as today.

- [ ] **Step 1: Write `check-heights.mjs`** (desktop and phone):
  - `t1`: `dkHeights.set({ v138Iv: 0.30, cvLane: 0.10 })` then wait 300 ms. The heights of `#v138Iv` and `#cvLane` are within 2 px of `0.30·ph` and `0.10·ph`, where `ph = #paneG.clientHeight`.
  - `t2`: `set({ v138Iv: 0.9 })`. Candles (`#paneG>.chart-box`) are at least 240 px on desktop and 180 px on a phone, and every shown lane is at least 48 px.
  - `t3`: with `set({ v138Iv: 0.30 })`, switch on one more lane through `W.v132ind` (the builder picks an off lane). The new lane is at least 48 px and `#v138Iv` keeps a share of 0.30 ± 0.03 relative to the sum of the saved lanes.
  - `t4`: `reset()`. The heights equal a fresh load's (within 2 px).
  - `t5`: the profile follows `body.gfs`: adding `gfs` gives `profile()` ending in `|full`.
- [ ] **Step 2: Run it on the current page.** Expected: FAIL (`dkHeights` undefined).
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run it again.** Expected: t1–t5 true at both viewports. `check-desk.mjs` still passes.
- [ ] **Step 5: Commit.** `"feat(desk): saved height shares per device and view, applied by v133.fit"`

---

### Task 4: Drag dividers (mouse and touch), reset, and the old handles removed

**Files:**
- Modify: `frontend/index.html`. A new `<script data-module="dkSplit">` after the v133 script. The ƒx menu gets a "Reset heights" button (same pattern as `.v138-presets`, ~49748). The `.gfs-split` script (~31570–31610) and its CSS (~12691–12745) are removed, along with the `gfs_split_v1` key.
- Create: `tools/perf/check-drag.mjs`

**Interfaces:**
- Consumes: `dkHeights` (Task 3), the bus `page` event, and the lanes `fit()` lists.
- Produces:
  - `.dk-split` elements inside `#paneG`, one above each shown lane in visual order (by `offsetTop`). Each is 22 px tall, centred on the boundary, `touch-action:none`, `cursor:row-resize`, with a grip; the class `.drag` is set while dragging; `role="separator"`, `aria-orientation="horizontal"`.
  - Their positions update after each `fit()` and on a `ResizeObserver` on `#paneG`.
  - Dragging a divider by `dy` moves `dy/ph` of share from the lane below to the region above (the candles or the lane above), with the minimums applied live, through `dkHeights.set` (one fit per animation frame).
  - On the first drag with no saved shares, the current heights are saved as the starting shares.
  - A double-tap or double-click within 320 ms resets that pair to its default proportion.
  - `#dkResetH` in `#v132Ind` calls `dkHeights.reset(dkHeights.profile())`.

- [ ] **Step 1: Write `check-drag.mjs`:**
  - `desk`: mouse-drag (CDP `Input.dispatchMouseEvent`) the divider above `#cvLane` down by 60 px. `#cvLane` shrinks by 60 ± 3 px, the region above grows by the same, and `#paneG`'s total is unchanged.
  - `persist`: reload the page. The `#cvLane` height matches the dragged height ± 2 px.
  - `phone` (390x844, mobile): touch-drag (CDP `Input.dispatchTouchEvent`) the first divider up by 40 px. The candles shrink by about 40 px and `scrollY` is unchanged.
  - `swipe`: a vertical touch swipe in the middle of the candles leaves every lane height unchanged.
  - `dbl`: a double-click on the divider restores that pair's default heights ± 2 px.
  - `resetBtn`: click `#dkResetH`. All heights equal a fresh load's.
  - `oldGone`: no `.gfs-split` in the document.
- [ ] **Step 2: Run it.** Expected: FAIL (no `.dk-split`).
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run `check-drag.mjs`, `check-heights.mjs` and `check-desk.mjs`.** Expected: all pass. The inventory is the before list plus `#dkToolsBtn`, minus nothing; `.dk-split` is not a button, so it is not listed.
- [ ] **Step 5: Commit.** `"feat(desk): CoinGlass-style drag dividers for candles and every lane"`

---

### Task 5: Full screen, steadiness, and finish

**Files:**
- Create: `tools/perf/check-steady.mjs`, `docs/superpowers/reports/2026-11-03-desk-chart-page.md`

- [ ] **Step 1: Write `check-steady.mjs`:**
  - `full`: add `body.gfs` (or click the full-screen control), wait 1 s. `#chartp`'s bottom is within 4 px of `innerHeight`, and the `phone|full` / `desk|full` shares apply on their own (set different shares in normal view first, and they must not carry over).
  - `steady`: a MutationObserver on the `style` attribute of `#paneG` and every lane, over 60 s with no input. Height and max-height changes must be 0.
- [ ] **Step 2: Run it at both viewports.** Expected: pass. If `steady` fails, find the second height writer (the `check-who.mjs` method) and make it go through `fit()`.
- [ ] **Step 3: Perf sanity.** Run `tools/perf/measure.mjs` (isolated) on before and after. Expected: Desk task ms/min not more than 10% above before.
- [ ] **Step 4: Report.** Write the summary: what changed, the check results, before/after numbers, and the owner's phone checks (drag each favourite lane, full screen, open Tools and use My trade · P&L, reload keeps heights).
- [ ] **Step 5: Commit.** `"docs: desk chart page report"`. Ask the owner before deploying.
