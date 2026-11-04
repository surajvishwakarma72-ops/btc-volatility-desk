# Graphite Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CoinGlass-style graphite dark theme and its light twin across the whole terminal, with every chart restyled live when the theme switches.

**Architecture:** One late `<style id="v174Theme">` sets the colour tokens for `data-theme="dark"` and `"light"`, so it beats the older layers. `window.dkTheme` restyles every chart in `window.__lwcReg` when it is created and on the `desk80` `theme` event. Hard-coded colours on the Desk, header, toolbar and their menus are moved onto tokens.

**Tech Stack:** One plain-JS `frontend/index.html` (lightweight-charts v4). Checks run in headless Chrome via `tools/perf/run-page.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-03-graphite-theme-design.md`

## Global Constraints

- Dark: bg/chart #17181C, grid rgba(255,255,255,.05) horizontal only, up #2EBD85, down #E0475E, text #DADCE0, muted #8A8F98, pane lines #26282E, accent #7AA7FF.
- Light: bg/chart #FFFFFF, panels #F5F6F8, grid rgba(0,0,0,.05), up #16A673, down #D9304F, text #1F2329, muted #7A808A, pane lines #E6E8EB, accent #2F6BFF.
- Font: Inter (added to the existing Google Fonts link); Barlow is kept only where narrow numerals are needed.
- No layout or control changes. The job 2 inventory must be identical in both themes.
- Volume bars only if the BTC series already carries volume. No new data.
- Don't commit `frontend/dist`. Never place, change or cancel a real order. Deploy only after the owner approves screenshots.

## Review Focus

1. **A chart created after a theme switch** (for example a lane switched on later) gets the current theme, not the one at load. Test in Task 2.
2. **Series with deliberate fixed colours** (P&L lines, session bands) keep them; only the shared chrome changes. Test in Task 2.
3. **Text that was hard-coded white or dark** becomes unreadable in the other theme. Covered by the contrast check in Task 3.
4. **Up/down colours disagree** between candles, legends and P&L in one theme. Test in Task 3 (`--up`/`--down`/`--pos`/`--neg` resolve to the same pair as the candles).
5. **Rapid theme toggling** leaves some charts in the old theme. Test in Task 2 (toggle 3 times, read back each chart).

---

### Task 1: Theme tokens and font

**Files:**
- Modify: `frontend/index.html`. Add `<style id="v174Theme">` as the last style in `<head>`, and add Inter to the Google Fonts link (~644).
- Create: `tools/perf/check-theme.mjs`

**Interfaces:**
- Produces: CSS variables under `:root[data-theme="dark"]` and `:root[data-theme="light"]` for every colour token in use: at least `--bg --panel --panel2 --panel3 --line --line2 --text --muted --faint --chart-bg --up --down --c-up --c-dn --pos --neg --focus --label-bg --term-line --iv-line --warn --ok` (the builder greps for the rest and maps them to the closest role), plus `--font` with Inter first. Sets `html[data-theme] body { font-family: var(--font) }`.

- [ ] **Step 1: Write `check-theme.mjs`.** For `dark` then `light` (set `document.documentElement.dataset.theme`, then emit the `desk80` `theme` event), read `getComputedStyle(document.documentElement)` for `--bg --chart-bg --up --down --text --muted --line`, and the body font. Expected: the exact Global Constraints values (case-insensitive) and a font list starting with `Inter`.
- [ ] **Step 2: Run on the current page.** Expected: FAIL (`--bg` is #0B141C).
- [ ] **Step 3: Implement** the style block and the font link.
- [ ] **Step 4: Run at 1440x900 and 390x844,mobile.** Expected: pass. Run `tools/perf/parse-check.cjs`: 0 errors.
- [ ] **Step 5: Commit.** `"feat(theme): graphite dark and light tokens, Inter"`

### Task 2: Charts follow the theme through the registry

**Files:**
- Modify: `frontend/index.html`. A new `<script data-module="dkTheme">` after the chart registry (~21700). Hook it where the registry records a chart.
- Create: `tools/perf/check-theme-charts.mjs`

**Interfaces:**
- Produces: `window.dkTheme = { palette(): {bg, grid, up, down, text, muted, line, accent, font}, applyChart(entry): void, applyAll(): void }`.
  - `applyChart` sets on the chart: `layout.background` (solid, `--chart-bg`), `layout.textColor`, `layout.fontFamily`, `grid.vertLines.visible = false`, `grid.horzLines.color`, crosshair line colours, and `rightPriceScale`/`timeScale` border colours.
  - On candlestick series it sets `upColor`, `downColor`, `wickUpColor`, `wickDownColor`, `borderVisible:false`, `priceLineVisible:true`, `lastValueVisible:true`, `priceLineStyle: 2` (dotted).
  - A series created with explicit non-default colours (anything other than the library defaults #26a69a/#ef5350, or a line series with `color` set by its module) keeps its colours. Only chrome and default-coloured candles change.
  - `applyAll` runs `applyChart` over `__lwcReg.charts` and is called on `desk80.on('theme')` and once at boot. New charts are styled at registration.
  - The BTC chart also gets the watermark "Volatility Desk" (font size 26 desktop / 18 phone, colour `rgba(text, .035)`), and its legend shows O·H·L·C in the candle colour (extend the existing BTC legend; the builder finds its renderer via `#legendG`).
  - Volume: if the BTC bars have `volume`, add one histogram series (pane margin bottom 0.82) coloured up/down at 20% alpha. Otherwise skip, and note it in the report.

- [ ] **Step 1: Write `check-theme-charts.mjs`.** On the Desk with ATM IV, Speed vs IV and Short Strangle on, for each theme, read every registered chart's `chart.options().layout.background.color` and the BTC candle series options. Expected:
  - every chart's background equals the theme `--chart-bg`, and BTC `upColor`/`downColor` equal the theme pair;
  - after toggling the theme 3 times quickly and waiting 500 ms, the same still holds (Review Focus 5);
  - a lane switched on **after** a toggle has the current background (Review Focus 1);
  - a series whose module set its own colour (record one before the toggle, e.g. the Short Strangle risk line) keeps it (Review Focus 2).
- [ ] **Step 2: Run on the Task 1 page.** Expected: FAIL (backgrounds still #0F1C28/#0E1923).
- [ ] **Step 3: Implement** `dkTheme`, the registration hook, the watermark, the O·H·L·C legend and volume (conditional).
- [ ] **Step 4: Run at both sizes.** Expected: pass. `check-drag.mjs` and `check-desk.mjs` still pass.
- [ ] **Step 5: Commit.** `"feat(theme): every chart restyled live from the registry; BTC OHLC line, price tag, watermark"`

### Task 3: Hard-coded colours on the Desk, header, toolbar and menus; contrast; screenshots

**Files:**
- Modify: `frontend/index.html`. Replace literal colours with tokens in the rules and inline styles for `#gTop`, `header.top.hdr`, `#tk`, `#tabbar`, `#dkTools`, `#v132Ind`, the strike picker sheet (v165), `#vUniversalFloatingPnl`, alert and news sheets (v145, v148), the clock (v147), and lane legends inside `#paneG`.
- Create: `tools/perf/check-contrast.mjs`, `tools/perf/shots.mjs`, `docs/superpowers/reports/2026-11-03-theme-leftovers.md`

**Interfaces:**
- `check-contrast.mjs` returns, per theme, every visible text element in the areas above whose contrast ratio against its effective background (walking up to the first opaque background) is under 4.5:1 for normal text or 3:1 for text that is ≥ 18.66 px bold or ≥ 24 px. Also `upDownSame`: `--up`/`--c-up`/`--pos` and `--down`/`--c-dn`/`--neg` resolve to the theme pair.
- `shots.mjs` saves PNGs (CDP `Page.captureScreenshot`) to `docs/superpowers/reports/theme-shots/` as `<theme>-<desk|phone>-<desk|tools|fx|strike>.png`.

- [ ] **Step 1: Run `check-contrast.mjs`** on the Task 2 page, both themes, both sizes. Expected: FAIL with a list of failing elements.
- [ ] **Step 2: Fix each listed element** by moving its colour onto a token. Anything outside the areas above goes to `…theme-leftovers.md` (selector, page, colour), not fixed.
- [ ] **Step 3: Rerun.** Expected: zero failures in the listed areas, `upDownSame` true in both themes, and the inventory identical to before in both themes.
- [ ] **Step 4: Take the screenshots** (both themes × phone/desktop × Desk, Tools open, ƒx menu, strike picker).
- [ ] **Step 5: Commit.** `"feat(theme): Desk, header, toolbar and menus on tokens; contrast checked; screenshots"`. Show the owner the screenshots before any deploy.
