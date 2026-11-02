# Job 2 — The Desk as a chart page, with resizable chart heights

Date: 3 Nov 2026 · Status: waiting for owner approval · Follows job 1 (speed + paper, deployed 3 Nov)

## Why

The owner uses the first page (Desk) for charting. Today the chart panel shares the page with eight other sections,
and no chart or indicator height can be changed: the old drag handle exists only in full screen, only for BTC, Volume and ADX
(`frontend/index.html` `.gfs-split`, ~12691 / ~31586). On the phone nothing can be resized at all.

The owner wants the charts to get the most space possible, the way CoinGlass does. Every chart and indicator should be
resizable by dragging, on phone and desktop. The favourite lanes are ATM IV, Speed vs IV and Short Strangle, but every
lane counts.

Approved in the visual companion: option **A, fit the screen** (dragging a divider takes space from the neighbour; the stack
always fills the screen, no scrolling), and the "Tools ▾" panel for everything that isn't the chart.

## Goals

1. **The chart panel (`#chartp`) gets the whole Desk.** Every part of it stays exactly as it is today:
   - the top toolbar `#gTop` (timeframes, 🏆 Top, Telegram, TF, ƒx Indicators, Alerts, Trade Clock, Economy, News,
     Expected move, Panes ▾);
   - the left drawing rail `#v132Left`;
   - legends, the dealer-flows line, impulse tag, zoom buttons, per-section zoom and fit, and readout boxes such as
     USUAL FALL;
   - the bottom bar `#gBot` and every indicator lane.
2. **Everything else on the Desk moves into a "Tools ▾" panel** opened from a new button in `#gTop`: Tonight
   (`#v89Rail`), Leading signals (`#v104Lead` / `#v22Side`), the vol row (`#volRow`) if still shown outside the chart,
   `#side2` (events, vol turn and so on), `#flowRow` (option flow, order-flow, positioning) and My trade · P&L
   (`#v110PnlHd` + `#v18Trade`).
   - The panel hangs from the toolbar over the charts, scrolls inside itself, and closes on a second tap or Esc.
   - Each section keeps its own content and behaviour.
3. **The floating P&L pill stays on top of the chart.**
4. **Resizable heights, CoinGlass style:**
   - A divider sits between the BTC candles and the first lane, and between every two lanes.
   - Dragging it makes one side taller and the other shorter. The stack always fills its space.
   - Minimum heights so nothing vanishes: candles 180 px on a phone and 240 px on desktop; a lane 48 px.
   - Double-tapping (or double-clicking) a divider resets that pair. "Reset heights" in the ƒx Indicators menu resets all.
5. **Phone-friendly dividers:**
   - A 22–24 px touch strip with `touch-action: none` and a visible grip that lights up while dragging.
   - It must never start a page scroll, and a normal swipe on the chart must not grab it.
6. **Saved per device and view:** the shares go in localStorage, with separate profiles for phone and desktop
   (width ≤ 760 px is a phone, the same rule `fit()` uses), each with a normal and a full-screen set.
7. **Turning lanes on and off:** the other lanes keep their shares; a lane switched on starts at its default share.
8. **Full screen** keeps using the whole screen (as today: no tab bar, to the bottom edge), now with the user's shares.

## Non-goals

- Restyling the charts (colours, fonts, the CoinGlass look). That is **job 3**, right after this one.
- Removing or redesigning any control, readout or lane on the chart.
- Any change to data, alerts, the algo, paper or live trading.

## Anti-goals (a failure even if it works)

- Any chart control or readout that was on the chart panel and is now missing or broken.
- Blinking or a resize loop. Two owners of lane heights caused exactly this before (see the v134 and v144 notes near
  `fit()`); there must be one owner.
- Dragging a divider on the phone scrolls the page, or scrolling the page grabs a divider.
- A section moved into Tools stops collecting data that alerts depend on. Moving it may pause its drawing while hidden,
  never its feeds or alerts.

## How it should work (decided)

- **One owner of heights: `v133.fit()`** (~47829) already sizes the chart block to the screen and splits it between candles
  and lanes by fixed weights (`wt()`: ATM IV 3 on phone / 2.2 on desktop, Speed vs IV 1.4, Short Strangle 3.2, others 1,
  ADX 1.4). The user's saved shares replace those weights when present. The dividers only change the saved shares and
  ask `fit()` to run (at most once per frame while dragging). No second sizer.
- **Desk order:** `arrange()` (`v105_22Arrange`, ~21252) puts only the chart block (`#v22Top` with `#chartp`) on the Desk and
  the rest in the Tools panel container, in the same order as today. On wide desktop, the Leading-signals side column
  (`#v22Side`) also goes to Tools so the chart is full width.
- **The old full-screen-only handles** (`.gfs-split`, `gfs_split_v1`) are replaced by the new dividers; the ADX and Volume
  boxes become ordinary lanes for resizing.

## Constraints

- One `frontend/index.html` (plain JS, Vite build). The Dockerfile copies it; don't commit `frontend/dist`.
- Builds on job 1's `desk80` bus (`every`, `onOpenPage`) and the dev perf meter.
- Panels in a closed Tools drawer are not visible, so modules that check visibility pause their drawing. That is
  intended (it saves work), but each must redraw when the panel opens.
- Never place, change or cancel a real order while testing.

## Done when

- On a phone (≤ 760 px) and on desktop, every lane and the candles can be resized by dragging; the sizes survive a reload
  and are kept separately for phone/desktop and normal/full screen.
- The Desk shows only the chart panel and the P&L pill. Tools ▾ opens every other section, and each works there.
- Every control and readout in the goal 1 list is still present and works (checked by an inventory before and after).
- No blinking: lane heights are steady for 60 s without input (no height changes in a mutation log).
- Full screen fills the screen with the user's shares.

## Calls I made (owner can overrule)

- "Zoom" in the owner's request is read as the full-screen button. The per-section zoom and fit buttons keep working as today.
- Minimum heights: candles 180 / 240 px, lanes 48 px.
- Leading signals moves to Tools on desktop too, for a full-width chart.
- Heights are stored as shares, not pixels, so they scale with the screen and with full screen.

## Left to the builder

- The exact markup and styles of the Tools button and panel (match the toolbar's look).
- How shares map onto `fit()`'s budget, keeping its existing minimums and the time-axis row.
- How to test the drag in headless Chrome (CDP touch and mouse events) and the before/after control inventory.
