# Job 2 — The Desk as a chart page, with resizable heights: summary

Branch `feat/desk-chart-page` (from `feat/multi-asset-phase-1` at ab04e9c). Not deployed.

## What changed (`frontend/index.html`)

- **The Desk shows only the chart panel.** Every toolbar button, the drawing rail, legends, readouts and lanes stay where
  they were (checked by a before/after control inventory).
- **Tools ▾** (new button in the chart toolbar) drops a panel over the charts. It shows Events / vol turn and the flow
  row (Option flow, Order-flow, Positioning). An earlier version (v89 / v133 "clean first screen") had hidden those from
  the Desk, so this brings them back one tap away. It closes on a second tap, Esc, a page switch or full screen.
  Sections the owner switched off, and the retired Leading-signals board, stay hidden.
- **The desktop side column** (now empty apart from its toggle) starts folded, so the chart gets the full width. Its
  "‹ Signals" toggle still brings it back.
- **Drag dividers, CoinGlass style.** A divider sits above every lane (the first one between the candles and the first
  lane). Dragging moves height between the two sides; it works with mouse and touch, and the strip is 22 px with a
  grip. Double-click or double-tap resets a pair, and "Reset heights" in the ƒx Indicators menu resets everything on
  the device.
- **Saved per device and view.** Phone and desktop, normal and full screen, each have their own heights, stored as
  shares in `desk_heights_v1`.
- **One owner of heights.** `v133.fit()` applies the saved shares; the dividers only change them. The old full-screen-only
  handles (`.gfs-split`) are gone, and ADX in full screen follows the dragged height.
- **Minimums.** Lanes never go under 48 px. The candles never go under 240 px on desktop or 180 px on a phone, or under
  what the default layout already gives them if that is less. On a phone the defaults leave the candles at about
  160 px, because Short Strangle takes 268.
- **Phone full screen** now uses the whole screen: the tab bar steps aside, and the header's full-screen button
  brings it back.

## Checks (headless Chrome, `tools/perf/*.mjs`, desktop 1440×900 and phone 390×844 touch)

| Check | Desktop | Phone |
|---|---|---|
| check-desk: Desk = chart only, Tools opens/closes (Esc, page, full screen), P&L pill kept, no Desk re-appends | pass | pass |
| check-heights: shares applied, minimums held, new lane at its default, reset, profiles | pass | pass |
| check-drag: drag moves the lane, no page scroll, swipe doesn't grab, persists after reload, double-click resets, Reset heights | pass | pass |
| check-steady: full screen fills, separate full-screen heights, back to normal heights, no height change for 60 s | pass | pass |
| Inventory vs before | no control lost, + Tools ▾ | no control lost, + Tools ▾ |
| Desk load (isolated, ms/min) | 3862 → 3808 | — |

`#alBtn`, `#calBtn` and `#rpBtn` (Alerts, Replay and Go to on the chart rail) did not mount in the test browser on either
the old or the new page. They hang on `#gRail`, which another module builds on a timer. Please confirm on your phone.

## Owner's phone checks after deploy

1. Drag the divider above ATM IV, Speed vs IV and Short Strangle, and between the candles and the first lane.
2. Reload: the heights stay.
3. Full screen: the chart fills the screen, the tab bar steps aside, and the button at the top exits.
4. Tools ▾ opens Events and the flow row.
5. Alerts, Replay and Go to are still on the chart rail.
