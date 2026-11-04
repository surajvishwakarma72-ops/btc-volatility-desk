# Job 3 — CoinGlass-style graphite theme (dark and light), whole terminal

Date: 3 Nov 2026 · Status: waiting for owner approval · Follows job 2 (chart-only Desk, deployed 3 Nov)

## Why

The owner wants the terminal to look like CoinGlass. In the visual companion they picked **B, graphite**, and asked for a
matching **light** twin, both applying to the **whole terminal**: charts, panels, toolbar, header and menus. The theme
switch flips between them.

## Approved look (from the mockups)

| | Dark (graphite) | Light |
|---|---|---|
| Page / chart background | #17181C | #FFFFFF (panels #F5F6F8) |
| Grid | horizontal only, rgba(255,255,255,.05) | horizontal only, rgba(0,0,0,.05) |
| Up / down candles | #2EBD85 / #E0475E | #16A673 / #D9304F |
| Text / muted | #DADCE0 / #8A8F98 | #1F2329 / #7A808A |
| Lines between panes | #26282E | #E6E8EB |
| Accent line (e.g. ATM IV) | #7AA7FF | #2F6BFF |
| Font | Inter (chart labels and UI) | Inter |

Chart details:
- Candles slightly thinner.
- O · H · L · C values in the BTC legend line, coloured by the candle.
- A live price tag on the right axis with a dotted line across.
- Faint volume bars under the candles, only if the BTC feed already carries volume.
- A faint "Volatility Desk" watermark.
- Lane titles in the text colour, their value in the line's colour.

## Goals

1. **One theme layer** that sets the design tokens (`--bg`, `--panel`, `--panel2`, `--line`, `--line2`, `--text`,
   `--muted`, `--up`, `--dn`/`--neg`, `--focus`, `--chart-bg`, `--font` and any others the terminal uses) for
   `data-theme="dark"` and `data-theme="light"`. It is loaded after the many older layers (about 111 theme rules today),
   so it wins without editing each one.
2. **Every chart restyled through the chart registry** (`window.__lwcReg`, ~21680): background, text, font, grid,
   candle colours, price line and tag, and watermark. This runs when a chart is created and again on the `desk80`
   `theme` event, so switching theme redraws all charts with no reload.
3. **Panels, toolbar, header, menus, the Tools panel, the P&L pill, alerts and modals** follow the tokens. Hard-coded
   colours that ignore the theme are replaced with tokens on the Desk, the header and toolbar, the Tools panel and every
   menu or sheet opened from them (ƒx, strike picker, alerts, clock, news). Other pages get the tokens through goal 1;
   anything left hard-coded there is listed for later, not chased now.
4. **Inter is loaded** (added to the existing Google Fonts link). Barlow stays only where a module needs narrow numerals,
   and the builder's list says where.
5. **The light theme** is a real twin: the same layout and readable colours, and nothing stays dark on white.

## Non-goals

- New data. Volume bars appear only if the series already has volume.
- Layout changes. The Desk, dividers and Tools panel from job 2 stay as they are.
- Restyling every hard-coded colour on every page. That is the fix list's "theme everywhere" item, and it gets a list
  from this job.

## Anti-goals

- A control, readout or lane that vanishes or becomes unreadable (for example dark text on the dark background).
- Charts that need a reload to change theme.
- Up/down colours that disagree between the candles, the P&L and the legends in the same theme.

## How it should work (decided)

- **Tokens first:** a single `<style id="v174Theme">` near the end of `<head>` (after the other theme styles) with
  `:root[data-theme="dark"]` and `:root[data-theme="light"]` blocks.
- **Charts:** one applier `window.dkTheme.applyChart(entry)` walks `__lwcReg.charts` and sets chart options (`layout`,
  `grid`, `crosshair`, `watermark`) and series options by series type (candles, line, area, histogram).
  - It runs for new charts (hook where the registry records a chart) and on `desk80.on('theme')`.
  - Modules that set their own chart colours on purpose (for example a lane with a fixed colour scheme) keep their
    series colours; only the shared chart chrome changes.
- **Theme switch:** the existing switch (`data-theme` on `<html>`) stays the control.

## Constraints

- One `frontend/index.html`, plain JS; `frontend/dist` not committed. Checks run in headless Chrome
  (`tools/perf/run-page.mjs`).
- The control inventory (job 2's `inventory.mjs`) must stay the same in both themes.
- Never place, change or cancel a real order.

## Done when

- At phone and desktop sizes, in both themes:
  - Screenshots of the Desk, the Tools panel open, the ƒx menu and the strike picker sheet show the approved colours.
  - There is no unreadable text (a contrast check on visible text: at least 4.5:1 for body text, 3:1 for large or bold).
- Switching theme with the existing switch restyles every chart without a reload (chart background read back from each
  chart matches the theme).
- The control inventory is unchanged in both themes.
- The owner approves screenshots before deploy.

## Calls I made (owner can overrule)

- Inter for the UI and the charts (CoinGlass uses a similar clean sans).
- Light theme colours as in the table, derived from the dark choice.
- Hard-coded colours are fixed on the Desk, header, toolbar and menus now; other pages get tokens only, plus a list.

## Left to the builder

- The full token list (find every `--*` colour variable in use) and their light/dark values from the table.
- Where each chart sets colours, and which series keep theirs.
- The contrast-check script and the screenshot set.
