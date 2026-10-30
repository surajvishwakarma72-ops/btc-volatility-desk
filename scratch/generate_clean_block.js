import fs from 'fs';

// Let's create the complete replacement block
const styleBlock = `<style id="vLivePnlTickCss">
/* vLivePnlTick · Live Tick-by-Tick P&L Graph & Real Delta Fills Start-to-Exit Lifecycle */
#vLivePnlTick {
  background: var(--panel, #11151c);
  border: 1px solid var(--line2, rgba(255,255,255,0.08));
  border-radius: 12px;
  padding: 16px 18px;
  margin: 14px 0 20px 0;
  box-shadow: 0 4px 20px rgba(0,0,0,0.35);
  font-family: var(--font, system-ui, sans-serif);
  position: relative;
  overflow: visible;
  z-index: 10;
  transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}
#pgPnl > #vLivePnlTick {
  order: -9999 !important;
}

/* Light Theme Overrides for #vLivePnlTick */
#vLivePnlTick.v-light,
:root[data-theme="light"] #vLivePnlTick {
  background: #ffffff !important;
  border-color: #cbd5e1 !important;
  box-shadow: 0 4px 24px rgba(0,0,0,0.07) !important;
  color: #0f172a !important;
}
#vLivePnlTick.v-light .v-title,
:root[data-theme="light"] #vLivePnlTick .v-title {
  color: #0f172a !important;
}
#vLivePnlTick.v-light .v-kpi,
:root[data-theme="light"] #vLivePnlTick .v-kpi,
#vLivePnlTick.v-light .v-leg-box,
:root[data-theme="light"] #vLivePnlTick .v-leg-box {
  background: #f8fafc !important;
  border-color: #e2e8f0 !important;
}
#vLivePnlTick.v-light .v-kpi-lbl,
:root[data-theme="light"] #vLivePnlTick .v-kpi-lbl {
  color: #64748b !important;
}
#vLivePnlTick.v-light .v-kpi-num,
:root[data-theme="light"] #vLivePnlTick .v-kpi-num,
#vLivePnlTick.v-light .v-leg-title,
:root[data-theme="light"] #vLivePnlTick .v-leg-title {
  color: #0f172a !important;
}
#vLivePnlTick.v-light .v-chart-wrap,
:root[data-theme="light"] #vLivePnlTick .v-chart-wrap {
  background: #f8fafc !important;
  border: 1px solid #e2e8f0 !important;
}
#vLivePnlTick.v-light .v-acc-tabs,
:root[data-theme="light"] #vLivePnlTick .v-acc-tabs {
  background: #f1f5f9 !important;
  border-color: #e2e8f0 !important;
}
#vLivePnlTick.v-light .v-acc-btn,
:root[data-theme="light"] #vLivePnlTick .v-acc-btn {
  color: #64748b !important;
}
#vLivePnlTick.v-light .v-acc-btn.active,
:root[data-theme="light"] #vLivePnlTick .v-acc-btn.active {
  background: #2563eb !important;
  color: #ffffff !important;
}
#vLivePnlTick.v-light .v-chart-wrap .v-tooltip,
:root[data-theme="light"] #vLivePnlTick .v-chart-wrap .v-tooltip {
  background: #ffffff !important;
  border-color: #cbd5e1 !important;
  color: #0f172a !important;
  box-shadow: 0 4px 20px rgba(0,0,0,0.12) !important;
}
#vLivePnlTick.v-light .v-theme-btn,
:root[data-theme="light"] #vLivePnlTick .v-theme-btn {
  background: #f1f5f9 !important;
  border-color: #cbd5e1 !important;
  color: #0f172a !important;
}

/* Mode Bar (Tabs + Status + Theme Toggle) */
#vLivePnlTick .v-mode-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-wrap: wrap;
  gap: 10px;
  position: relative;
  z-index: 50;
}
#vLivePnlTick.v-light .v-mode-bar,
:root[data-theme="light"] #vLivePnlTick .v-mode-bar {
  border-bottom-color: #e2e8f0 !important;
}
#vLivePnlTick .v-mode-bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
#vLivePnlTick .v-acc-tabs {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.45);
  padding: 4px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  position: relative;
  z-index: 50;
}
#vLivePnlTick .v-acc-btn {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--muted, #94a3b8);
  cursor: pointer !important;
  pointer-events: auto !important;
  touch-action: manipulation !important;
  user-select: none;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
#vLivePnlTick .v-acc-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}
#vLivePnlTick .v-acc-btn.active {
  background: #2563eb !important;
  color: #ffffff !important;
  border-color: rgba(255, 255, 255, 0.3) !important;
  box-shadow: 0 2px 10px rgba(37, 99, 235, 0.5) !important;
}
#vLivePnlTick .v-mode-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
#vLivePnlTick .v-acc-btn.active .v-mode-dot {
  background: #38bdf8;
  box-shadow: 0 0 6px #38bdf8;
}
#vLivePnlTick .v-acc-btn:not(.active) .v-mode-dot {
  background: #64748b;
}
#vLivePnlTick .v-live-tag {
  font-size: 11px;
  font-weight: 800;
  color: #16c784;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: rgba(22, 199, 132, 0.15);
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(22, 199, 132, 0.35);
}
#vLivePnlTick .v-idle-tag {
  font-size: 11px;
  font-weight: 700;
  color: #94a3b8;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.05);
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
#vLivePnlTick .v-theme-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text, #eee);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  user-select: none;
  transition: all 0.15s ease;
}
#vLivePnlTick .v-theme-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

/* Head & KPIs */
#vLivePnlTick .v-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  flex-wrap: wrap;
  gap: 10px;
}
#vLivePnlTick .v-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
#vLivePnlTick .v-title {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: var(--text, #eee);
  display: flex;
  align-items: center;
  gap: 8px;
}
#vLivePnlTick .v-mode-badge {
  font-size: 10.5px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 6px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
#vLivePnlTick .v-mode-badge.live {
  background: rgba(22, 199, 132, 0.15);
  color: #16c784;
  border: 1px solid rgba(22, 199, 132, 0.3);
}
#vLivePnlTick .v-mode-badge.idle {
  background: rgba(246, 70, 93, 0.12);
  color: #f6465d;
  border: 1px solid rgba(246, 70, 93, 0.3);
}
#vLivePnlTick .v-head-right {
  display: flex;
  align-items: baseline;
  gap: 14px;
}
#vLivePnlTick .v-pnl-val {
  font-size: 26px;
  font-weight: 800;
  font-family: var(--mono, monospace);
  line-height: 1;
}
#vLivePnlTick .v-pnl-val.pos { color: #16c784; }
#vLivePnlTick .v-pnl-val.neg { color: #f6465d; }
#vLivePnlTick .v-pnl-val.zero { color: #aaa; }
#vLivePnlTick .v-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
#vLivePnlTick .v-kpi {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--line2, rgba(255,255,255,0.05));
  border-radius: 8px;
  padding: 8px 10px;
}
#vLivePnlTick .v-kpi-lbl {
  font-size: 10px;
  color: var(--muted, #888);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
#vLivePnlTick .v-kpi-num {
  font-size: 13.5px;
  font-weight: 700;
  font-family: var(--mono, monospace);
  color: var(--text, #eee);
}
#vLivePnlTick .v-legs-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 12px;
}
@media (max-width: 760px) {
  #vLivePnlTick .v-legs-grid { grid-template-columns: 1fr; }
}
#vLivePnlTick .v-leg-box {
  background: rgba(255,255,255,0.015);
  border: 1px solid var(--line2, rgba(255,255,255,0.06));
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
#vLivePnlTick .v-leg-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text, #eee);
}
#vLivePnlTick .v-leg-metrics {
  text-align: right;
  font-size: 11px;
  font-family: var(--mono, monospace);
  color: var(--muted, #aaa);
}
#vLivePnlTick .v-chart-wrap {
  position: relative;
  width: 100%;
  height: 190px;
  background: rgba(0,0,0,0.22);
  border-radius: 8px;
  overflow: hidden;
  user-select: none;
  touch-action: none !important;
  cursor: crosshair !important;
}
#vLivePnlTick .v-chart-svg {
  width: 100%;
  height: 100%;
  display: block;
}
#vLivePnlTick .v-chart-wrap .v-tooltip {
  position: absolute;
  pointer-events: none;
  background: #181d27;
  border: 1px solid rgba(255,255,255,0.25);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 11.5px;
  font-family: var(--mono, monospace);
  color: #fff;
  box-shadow: 0 6px 20px rgba(0,0,0,0.6);
  transform: translate(-50%, -115%);
  white-space: nowrap;
  display: none;
  z-index: 25;
}

/* Bottom bar & page isolation fixes: ensure #tabbar and #moreSheet are always clickable */
html body #tabbar,
html body .tabbar {
  z-index: 9998 !important;
  pointer-events: auto !important;
}
html body #tabbar button,
html body .tabbar button {
  pointer-events: auto !important;
  cursor: pointer !important;
}
html body #moreSheet,
html body .more-sheet {
  z-index: 10000 !important;
  pointer-events: auto !important;
}
#pgPnl {
  padding-bottom: calc(var(--tab-h, 60px) + 50px) !important;
  box-sizing: border-box;
}

/* Floating P&L Widget - DRAGGABLE & EXPANDABLE DETAILS */
#vUniversalFloatingPnl {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9999;
  background: #181c24;
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 28px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  display: none;
  flex-direction: column;
  padding: 6px 14px;
  font-family: var(--font, system-ui, sans-serif);
  color: #eee;
  cursor: grab;
  user-select: none;
  touch-action: none;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}
#vUniversalFloatingPnl:active {
  cursor: grabbing;
}
#vUniversalFloatingPnl.v-light,
:root[data-theme="light"] #vUniversalFloatingPnl {
  background: #ffffff !important;
  border-color: #cbd5e1 !important;
  color: #0f172a !important;
  box-shadow: 0 8px 32px rgba(0,0,0,0.15) !important;
}
#vUniversalFloatingPnl .v-fpnl-main {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
#vUniversalFloatingPnl .v-fpnl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #16c784;
  flex-shrink: 0;
}
#vUniversalFloatingPnl .v-fpnl-dot.pulse {
  animation: vfpnlPulse 1.8s infinite;
}
@keyframes vfpnlPulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(22,199,132,0.7); }
  70% { transform: scale(1.15); box-shadow: 0 0 0 6px rgba(22,199,132,0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(22,199,132,0); }
}
#vUniversalFloatingPnl .v-fpnl-lbl {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted, #94a3b8);
}
#vUniversalFloatingPnl .v-fpnl-val {
  font-size: 14.5px;
  font-weight: 800;
  font-family: var(--mono, monospace);
}
#vUniversalFloatingPnl .v-fpnl-val.pos { color: #16c784; }
#vUniversalFloatingPnl .v-fpnl-val.neg { color: #f6465d; }
#vUniversalFloatingPnl .v-fpnl-val.zero { color: #888; }
#vUniversalFloatingPnl .v-fpnl-expand-btn {
  font-size: 11px;
  color: var(--muted, #94a3b8);
  margin-left: 4px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
}
#vUniversalFloatingPnl .v-fpnl-expand-btn:hover {
  color: #fff;
}
#vUniversalFloatingPnl.v-light .v-fpnl-expand-btn:hover {
  color: #000;
}

/* Floating Card Expanded Details */
#vUniversalFloatingPnl .v-fpnl-details {
  display: none;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  font-size: 11.5px;
  min-width: 210px;
}
#vUniversalFloatingPnl.v-light .v-fpnl-details,
:root[data-theme="light"] #vUniversalFloatingPnl .v-fpnl-details {
  border-top-color: #e2e8f0 !important;
}
#vUniversalFloatingPnl.expanded .v-fpnl-details {
  display: block;
}
#vUniversalFloatingPnl .v-fpnl-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 5px;
  font-family: var(--mono, monospace);
}
#vUniversalFloatingPnl .v-fpnl-jump {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 6px 10px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 700;
  text-align: center;
  cursor: pointer;
}
#vUniversalFloatingPnl .v-fpnl-jump:hover {
  background: #1d4ed8;
}
</style>`;

console.log('Style block length:', styleBlock.length);

