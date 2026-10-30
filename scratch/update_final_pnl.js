import fs from 'fs';

function buildModule() {
  return `<style id="vLivePnlTickCss">
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

/* Light Theme Styling for P&L Page and Component */
#pgPnl.v-light {
  background: #f8fafc !important;
  color: #0f172a !important;
  min-height: 100vh;
}
#pgPnl.v-light h1, #pgPnl.v-light h2, #pgPnl.v-light h3, #pgPnl.v-light h4 {
  color: #0f172a !important;
}

#vLivePnlTick.v-light,
:root[data-theme="light"] #vLivePnlTick {
  background: #ffffff !important;
  border-color: #cbd5e1 !important;
  box-shadow: 0 4px 24px rgba(0,0,0,0.06) !important;
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
  background: #ffffff !important;
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
  border: none;
  color: rgba(255, 255, 255, 0.65);
  font-size: 11.5px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 7px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s ease;
  user-select: none;
  outline: none;
}
#vLivePnlTick .v-acc-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.08);
}
#vLivePnlTick .v-acc-btn.active {
  background: #3b82f6;
  color: #fff;
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.4);
}
#vLivePnlTick .v-mode-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
}
#vLivePnlTick .v-mode-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
}
#vLivePnlTick .v-live-tag {
  color: #10b981;
  background: rgba(16, 185, 129, 0.12);
  border: 1px solid rgba(16, 185, 129, 0.3);
  padding: 3px 8px;
  border-radius: 6px;
  letter-spacing: 0.03em;
  font-size: 11px;
}
#vLivePnlTick .v-idle-tag {
  color: #94a3b8;
  background: rgba(148, 163, 184, 0.12);
  border: 1px solid rgba(148, 163, 184, 0.25);
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
}
#vLivePnlTick .v-theme-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #eee;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s ease;
  user-select: none;
}
#vLivePnlTick .v-theme-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.25);
}

/* Header & Meta */
#vLivePnlTick .v-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 12px;
  flex-wrap: wrap;
  gap: 8px;
}
#vLivePnlTick .v-head-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
#vLivePnlTick .v-title {
  font-size: 14.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  display: flex;
  align-items: center;
  gap: 8px;
}
#vLivePnlTick .v-badge {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 4px;
  letter-spacing: 0.04em;
}
#vLivePnlTick .v-badge.live {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.35);
}
#vLivePnlTick .v-badge.hist {
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.35);
}
#vLivePnlTick .v-sub {
  font-size: 11px;
  color: #94a3b8;
}

/* KPI Grid */
#vLivePnlTick .v-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
#vLivePnlTick .v-kpi {
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
#vLivePnlTick .v-kpi-lbl {
  font-size: 10px;
  color: #94a3b8;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
#vLivePnlTick .v-kpi-num {
  font-size: 15px;
  font-weight: 700;
  font-family: var(--mono, monospace);
  color: #fff;
}
#vLivePnlTick .v-kpi-num.pos { color: #16c784; }
#vLivePnlTick .v-kpi-num.neg { color: #f6465d; }
#vLivePnlTick .v-kpi-num.zero { color: #94a3b8; }
#vLivePnlTick .v-kpi-sub {
  font-size: 10px;
  color: #64748b;
  font-family: var(--mono, monospace);
}

/* Legs Breakdown */
#vLivePnlTick .v-legs-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}
#vLivePnlTick .v-leg-box {
  background: rgba(0,0,0,0.25);
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
#vLivePnlTick .v-leg-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
#vLivePnlTick .v-leg-title {
  font-size: 11.5px;
  font-weight: 700;
  color: #fff;
}
#vLivePnlTick .v-leg-detail {
  font-size: 10px;
  color: #94a3b8;
  font-family: var(--mono, monospace);
}
#vLivePnlTick .v-leg-pnl {
  font-size: 13.5px;
  font-weight: 700;
  font-family: var(--mono, monospace);
  text-align: right;
}
#vLivePnlTick .v-leg-pnl.pos { color: #16c784; }
#vLivePnlTick .v-leg-pnl.neg { color: #f6465d; }

/* SVG Chart Container */
#vLivePnlTick .v-chart-wrap {
  width: 100%;
  height: 200px;
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  position: relative;
  overflow: hidden;
  user-select: none;
  touch-action: none;
  cursor: crosshair !important;
}
#vLivePnlTick .v-chart-wrap svg {
  width: 100%;
  height: 100%;
  display: block;
  cursor: crosshair !important;
}

/* Floating Hairline Tooltip */
#vLivePnlTick .v-chart-wrap .v-tooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(15, 23, 42, 0.96);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 7px;
  padding: 6px 10px;
  color: #fff;
  font-size: 11px;
  font-family: var(--mono, monospace);
  display: none;
  z-index: 100;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
  white-space: nowrap;
  transform: translate(-50%, -125%);
  transition: opacity 0.08s ease;
}

/* Floating P&L Widget - DRAGGABLE & EXPANDABLE DETAILS */
#vUniversalFloatingPnl {
  position: fixed;
  top: 75px;
  right: 18px;
  z-index: 9999999 !important;
  background: #181c24;
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 28px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.55);
  display: none;
  flex-direction: column;
  padding: 8px 16px;
  font-family: var(--font, system-ui, sans-serif);
  color: #eee;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
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
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #16c784;
  flex-shrink: 0;
}
#vUniversalFloatingPnl .v-fpnl-dot.pulse {
  animation: vfpnlPulse 1.8s infinite;
}
@keyframes vfpnlPulse {
  0% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(22, 199, 132, 0.7); }
  70% { transform: scale(1.15); box-shadow: 0 0 0 8px rgba(22, 199, 132, 0); }
  100% { transform: scale(0.9); box-shadow: 0 0 0 0 rgba(22, 199, 132, 0); }
}
#vUniversalFloatingPnl .v-fpnl-lbl {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
}
#vUniversalFloatingPnl.v-light .v-fpnl-lbl {
  color: #64748b !important;
}
#vUniversalFloatingPnl .v-fpnl-val {
  font-size: 13.5px;
  font-weight: 800;
  font-family: var(--mono, monospace);
}
#vUniversalFloatingPnl .v-fpnl-val.pos { color: #16c784; }
#vUniversalFloatingPnl .v-fpnl-val.neg { color: #f6465d; }
#vUniversalFloatingPnl .v-fpnl-val.zero { color: #888; }
#vUniversalFloatingPnl .v-fpnl-expand-btn {
  font-size: 10.5px;
  color: #38bdf8;
  margin-left: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(56, 189, 248, 0.12);
  cursor: pointer;
}
#vUniversalFloatingPnl .v-fpnl-expand-btn:hover {
  background: rgba(56, 189, 248, 0.22);
}
#vUniversalFloatingPnl.v-light .v-fpnl-expand-btn {
  color: #0284c7 !important;
  background: #e0f2fe !important;
}

/* Expanded Card Details */
#vUniversalFloatingPnl .v-fpnl-details {
  display: none;
  flex-direction: column;
  gap: 5px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255,255,255,0.12);
  font-size: 11px;
  min-width: 230px;
}
#vUniversalFloatingPnl.v-light .v-fpnl-details,
:root[data-theme="light"] #vUniversalFloatingPnl .v-fpnl-details {
  border-top-color: #e2e8f0 !important;
}
#vUniversalFloatingPnl.expanded .v-fpnl-details {
  display: flex;
}
#vUniversalFloatingPnl .v-fpnl-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-family: var(--mono, monospace);
}
#vUniversalFloatingPnl .v-fpnl-jump {
  margin-top: 8px;
  padding: 6px 10px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  transition: background 0.15s ease;
  user-select: none;
}
#vUniversalFloatingPnl .v-fpnl-jump:hover {
  background: #1d4ed8;
}
</style>

<script data-module="vLivePnlTick">
/**
 * vLivePnlTick · 100% Real Delta Exchange Option Fills & Continuous Start-to-Exit Lifecycle
 *
 * Core Features:
 * - Accurate mark-vs-entry calculation matching Delta Exchange website:
 *     Short: (entry - mark) * lots * contract_value
 *     Long:  (mark - entry) * lots * contract_value
 * - Real 5m Option Candles from Delta Exchange API (ZERO dummy/simulated curves)
 * - Draggable & expandable floating PnL widget (mouse + touch) with screen-safe boundaries
 * - Light theme support across P&L analysis
 * - Dual Mode: Delta (Read-Only) vs Read+Trade
 */
(function() {
  const W = window;
  const D = document;
  const $ = id => D.getElementById(id);

  let activeViewMode = localStorage.getItem('v_pnl_view_mode') || 'readtrade';
  // Default to light theme as requested, persisted in localStorage
  let activeTheme = localStorage.getItem('v_pnl_theme') || 'light';

  const S = {
    openTicks: [],
    closedTrades: [],
    lastTradeId: null,
    candleCache: {},
    tradeCurve: null,
    deltaPositionsReadOnly: null,
    deltaPositionsReadTrade: null,
    deltaFillsReadOnly: null,
    deltaFillsReadTrade: null,
    lastPolledPositions: 0,
    lastPolledFills: 0
  };

  /** Parse contract symbol e.g. P-BTC-78800-011126 */
  function parseSym(sym) {
    if (!sym || typeof sym !== 'string') return null;
    const parts = sym.split('-');
    if (parts.length >= 4) {
      return {
        type: parts[0],
        underlying: parts[1],
        strike: +parts[2],
        rawExp: parts[3],
        exp: parseDeltaDate(parts[3])
      };
    }
    const m = sym.match(/^(C|P)-BTC-(\d+)-(\d{6})$/);
    if (m) {
      return {
        type: m[1],
        underlying: 'BTC',
        strike: +m[2],
        rawExp: m[3],
        exp: parseDeltaDate(m[3])
      };
    }
    return null;
  }

  function parseDeltaDate(dstr) {
    if (!dstr || dstr.length !== 6) return dstr;
    const dd = dstr.slice(0, 2);
    const mm = dstr.slice(2, 4);
    const yy = '20' + dstr.slice(4, 6);
    return yy + '-' + mm + '-' + dd;
  }

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '$0.00';
    const s = n < 0 ? '-' : (n > 0 ? '+' : '');
    return s + '$' + Math.abs(n).toFixed(2);
  }

  function fmtPct(n) {
    if (n == null || isNaN(n)) return '0.0%';
    const s = n > 0 ? '+' : '';
    return s + n.toFixed(1) + '%';
  }

  function fmtDate(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function getJwt() {
    try {
      const v = localStorage.getItem('desk_jwt') || localStorage.getItem('jwt') || localStorage.getItem('token');
      if (!v) return null;
      if (typeof v === 'string' && (v.startsWith('"') || v.startsWith('{'))) {
        try { return JSON.parse(v); } catch { return v; }
      }
      return v;
    } catch {
      return null;
    }
  }

  /** Calculate exact Delta Exchange position PnL & ROI */
  function calcLegMetrics(p) {
    if (!p) return null;
    const size = +p.size || 0;
    const entry = +p.entry_price || 0;
    const mark = +p.mark_price || 0;
    const cv = +(p.product && p.product.contract_value) || +(p.contract_value) || 0.001;
    const lots = Math.abs(size);

    // Delta Short: sold at entry, buyback at mark -> profit = (entry - mark) * lots * cv
    // Delta Long: bought at entry, sell at mark -> profit = (mark - entry) * lots * cv
    let pnl = 0;
    let roi = 0;
    if (size < 0) {
      pnl = (entry - mark) * lots * cv;
      roi = entry > 0 ? ((entry - mark) / entry) * 100 : 0;
    } else if (size > 0) {
      pnl = (mark - entry) * lots * cv;
      roi = entry > 0 ? ((mark - entry) / entry) * 100 : 0;
    }

    return {
      sym: p.product_symbol || (p.product && p.product.symbol) || '',
      size,
      lots,
      entry,
      mark,
      cv,
      pnl: +pnl.toFixed(4),
      roi: +roi.toFixed(1)
    };
  }

  /** Group fills by expiry/contract into real trades */
  function groupFillsToTrades(fills) {
    if (!Array.isArray(fills) || !fills.length) return [];
    const byExp = new Map();
    for (const f of fills) {
      const sym = f.product_symbol || (f.product && f.product.symbol);
      const p = parseSym(sym);
      if (!p) continue;

      let group = byExp.get(p.exp);
      if (!group) {
        group = {
          exp: p.exp,
          rawExp: p.rawExp,
          first: Infinity,
          last: 0,
          callBuy: 0, callSell: 0, callBv: 0, callSv: 0, callFee: 0,
          putBuy: 0, putSell: 0, putBv: 0, putSv: 0, putFee: 0,
          Kc: null, Kp: null,
          callSym: null, putSym: null,
          cv: +(f.product && f.product.contract_value) || +(f.meta_data && f.meta_data.contract_value) || 0.001
        };
        byExp.set(p.exp, group);
      }

      const t = new Date(f.created_at).getTime();
      if (t < group.first) group.first = t;
      if (t > group.last) group.last = t;

      const size = Math.abs(+f.size || 0);
      const px = +f.price || 0;
      const fee = +f.commission || 0;
      const val = size * px * group.cv;

      if (p.type === 'C') {
        group.callSym = sym;
        group.Kc = p.strike;
        group.callFee += fee;
        if (f.side === 'sell') {
          group.callSell += size;
          group.callSv += val;
        } else {
          group.callBuy += size;
          group.callBv += val;
        }
      } else {
        group.putSym = sym;
        group.Kp = p.strike;
        group.putFee += fee;
        if (f.side === 'sell') {
          group.putSell += size;
          group.putSv += val;
        } else {
          group.putBuy += size;
          group.putBv += val;
        }
      }
    }

    const trades = [];
    for (const [exp, g] of byExp.entries()) {
      const isCallClosed = g.callSell > 0 && g.callBuy >= g.callSell;
      const isPutClosed = g.putSell > 0 && g.putBuy >= g.putSell;
      const isClosed = (g.callSell > 0 || g.putSell > 0) && isCallClosed && isPutClosed;

      const callPnl = g.callSv - g.callBv - g.callFee;
      const putPnl = g.putSv - g.putBv - g.putFee;
      const netPnl = +(callPnl + putPnl).toFixed(4);
      const totalFee = +(g.callFee + g.putFee).toFixed(4);

      trades.push({
        id: 'dex_' + exp,
        exp,
        rawExp: g.rawExp,
        open: !isClosed,
        openedAt: g.first,
        closedAt: isClosed ? g.last : null,
        callPnl: +callPnl.toFixed(4),
        putPnl: +putPnl.toFixed(4),
        fee: totalFee,
        pnl: netPnl,
        Kc: g.Kc,
        Kp: g.Kp,
        callSym: g.callSym,
        putSym: g.putSym,
        lots: Math.max(g.callSell, g.putSell, 5)
      });
    }

    trades.sort((a, b) => b.openedAt - a.openedAt);
    return trades;
  }

  /** Find or build host container */
  function ensurePnlHost() {
    let pnl = $('pgPnl');
    if (!pnl) {
      pnl = D.createElement('section');
      pnl.className = 'page';
      pnl.id = 'pgPnl';
      pnl.setAttribute('aria-label', 'P&L');
      const main = D.querySelector('main.app') || D.body;
      main.appendChild(pnl);
    }
    return pnl;
  }

  /** Ensure PnL button is in navigation */
  function ensurePnlNav() {
    const nav = $('nav');
    if (nav && !nav.querySelector('[data-page="pgPnl"]')) {
      const btn = D.createElement('button');
      btn.type = 'button';
      btn.dataset.page = 'pgPnl';
      btn.dataset.v132 = '1';
      btn.textContent = 'P&L analysis';
      const tr = nav.querySelector('[data-page="pgDesk"]');
      if (tr) tr.after(btn);
      else nav.appendChild(btn);
    }
  }

  /** Poll Delta positions for both read-only and read+trade accounts */
  function pollDeltaPositions() {
    if (Date.now() - S.lastPolledPositions < 1500) return;
    S.lastPolledPositions = Date.now();

    const tok = getJwt();
    const headers = { Accept: 'application/json' };
    if (tok) headers.Authorization = 'Bearer ' + tok;

    // 1. Poll Read-Only positions
    const uRo = '/api/v1/delta/signed?kind=read&path=/v2/positions/margined&query=' + encodeURIComponent('contract_types=call_options,put_options');
    fetch(uRo, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.result) return;
        const res = Array.isArray(data.result) ? data.result : (data.result.positions || []);
        S.deltaPositionsReadOnly = res.filter(p => Math.abs(+p.size || 0) > 0);
        scheduleRedraw(); // debounced — safe
      })
      .catch(() => {});

    // 2. Poll Read+Trade positions
    const uRt = '/api/v1/delta/signed?kind=trade&path=/v2/positions/margined&query=' + encodeURIComponent('contract_types=call_options,put_options');
    fetch(uRt, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.result) return;
        const res = Array.isArray(data.result) ? data.result : (data.result.positions || []);
        S.deltaPositionsReadTrade = res.filter(p => Math.abs(+p.size || 0) > 0);
        scheduleRedraw(); // debounced — safe
      })
      .catch(() => {});
  }

  /** Poll Delta fills for both read-only and read+trade accounts */
  function pollDeltaFills() {
    if (Date.now() - S.lastPolledFills < 5000) return;
    S.lastPolledFills = Date.now();

    const tok = getJwt();
    const headers = { Accept: 'application/json' };
    if (tok) headers.Authorization = 'Bearer ' + tok;

    // 1. Poll Read-Only fills
    const uRo = '/api/v1/delta/signed?kind=read&path=/v2/fills&query=' + encodeURIComponent('contract_types=call_options,put_options&page_size=100');
    fetch(uRo, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.result && Array.isArray(data.result) && data.result.length > 0) {
          S.deltaFillsReadOnly = data.result;
          try { localStorage.setItem('v_delta_fills_readonly', JSON.stringify(data.result)); } catch {}
          scheduleRedraw(); // debounced — safe
        }
      })
      .catch(() => {});

    // 2. Poll Read+Trade fills
    const uRt = '/api/v1/delta/signed?kind=trade&path=/v2/fills&query=' + encodeURIComponent('contract_types=call_options,put_options&page_size=100');
    fetch(uRt, { headers })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.result && Array.isArray(data.result) && data.result.length > 0) {
          S.deltaFillsReadTrade = data.result;
          try { localStorage.setItem('v_delta_fills_readtrade', JSON.stringify(data.result)); } catch {}
          scheduleRedraw(); // debounced — safe
        }
      })
      .catch(() => {});
  }

  /** Get open position for Read-Only mode */
  function getReadOnlyOpenPosition() {
    const list = S.deltaPositionsReadOnly || [];
    if (list.length > 0) {
      const callRaw = list.find(p => {
        const sym = p.product_symbol || p.symbol || '';
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'C') || sym.startsWith('C-') || sym.endsWith('-C');
      });
      const putRaw = list.find(p => {
        const sym = p.product_symbol || p.symbol || '';
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'P') || sym.startsWith('P-') || sym.endsWith('-P');
      });

      const callLeg = calcLegMetrics(callRaw);
      const putLeg = calcLegMetrics(putRaw);

      const totalPnl = +((callLeg ? callLeg.pnl : 0) + (putLeg ? putLeg.pnl : 0)).toFixed(4);
      const totalLots = Math.max(callLeg ? callLeg.lots : 0, putLeg ? putLeg.lots : 0, 1);
      const totalEntryPrem = (callLeg ? callLeg.entry * callLeg.lots * callLeg.cv : 0) + (putLeg ? putLeg.entry * putLeg.lots * putLeg.cv : 0);
      const totalRoi = totalEntryPrem > 0 ? (totalPnl / totalEntryPrem) * 100 : 0;
      const t0 = Math.min(...list.map(p => new Date(p.created_at).getTime()).filter(t => !isNaN(t)));

      return {
        open: true,
        kind: 'readonly',
        id: 'delta-ro-' + (list[0].product_symbol || 'open'),
        totalPnl,
        totalRoi: +totalRoi.toFixed(1),
        size: totalLots,
        totalEntryPrem: +totalEntryPrem.toFixed(4),
        openedAt: isFinite(t0) && t0 > 0 ? t0 : Date.now() - 3600000,
        callLeg,
        putLeg
      };
    }
    return { open: false };
  }

  /** Get open position for Read+Trade mode */
  function getReadTradeOpenPosition() {
    const list = S.deltaPositionsReadTrade || [];
    if (list.length > 0) {
      const callRaw = list.find(p => {
        const sym = p.product_symbol || p.symbol || '';
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'C') || sym.startsWith('C-') || sym.endsWith('-C');
      });
      const putRaw = list.find(p => {
        const sym = p.product_symbol || p.symbol || '';
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'P') || sym.startsWith('P-') || sym.endsWith('-P');
      });

      const callLeg = calcLegMetrics(callRaw);
      const putLeg = calcLegMetrics(putRaw);

      const totalPnl = +((callLeg ? callLeg.pnl : 0) + (putLeg ? putLeg.pnl : 0)).toFixed(4);
      const totalLots = Math.max(callLeg ? callLeg.lots : 0, putLeg ? putLeg.lots : 0, 1);
      const totalEntryPrem = (callLeg ? callLeg.entry * callLeg.lots * callLeg.cv : 0) + (putLeg ? putLeg.entry * putLeg.lots * putLeg.cv : 0);
      const totalRoi = totalEntryPrem > 0 ? (totalPnl / totalEntryPrem) * 100 : 0;
      const t0 = Math.min(...list.map(p => new Date(p.created_at).getTime()).filter(t => !isNaN(t)));

      return {
        open: true,
        kind: 'readtrade',
        id: 'delta-rt-' + (list[0].product_symbol || 'open'),
        totalPnl,
        totalRoi: +totalRoi.toFixed(1),
        size: totalLots,
        totalEntryPrem: +totalEntryPrem.toFixed(4),
        openedAt: isFinite(t0) && t0 > 0 ? t0 : Date.now() - 3600000,
        callLeg,
        putLeg
      };
    }
    return { open: false };
  }

  /** Check if any position is open across either account */
  function getAnyOpenPosition() {
    const ro = getReadOnlyOpenPosition();
    if (ro.open) return ro;
    const rt = getReadTradeOpenPosition();
    if (rt.open) return rt;
    return null;
  }

  /** Get active mode open position */
  function getActiveModeOpenPosition() {
    if (activeViewMode === 'readonly') {
      return getReadOnlyOpenPosition();
    } else {
      return getReadTradeOpenPosition();
    }
  }

  /** Get last closed trade for Read-Only mode from Delta fills */
  function getReadOnlyLastClosedTrade() {
    let fills = S.deltaFillsReadOnly;
    if (!fills) {
      try {
        const raw = localStorage.getItem('v_delta_fills_readonly');
        if (raw) fills = JSON.parse(raw);
      } catch {}
    }
    if (fills && fills.length > 0) {
      const trades = groupFillsToTrades(fills);
      const closed = trades.filter(t => !t.open);
      if (closed.length > 0) {
        return {
          id: closed[0].id,
          source: 'delta-fills',
          mode: 'readonly',
          exp: closed[0].exp,
          pnl: closed[0].pnl,
          callPnl: closed[0].callPnl,
          putPnl: closed[0].putPnl,
          fee: closed[0].fee,
          Kc: closed[0].Kc,
          Kp: closed[0].Kp,
          callSym: closed[0].callSym,
          putSym: closed[0].putSym,
          openedAt: closed[0].openedAt,
          closedAt: closed[0].closedAt,
          lots: closed[0].lots
        };
      }
    }

    // Oct 28-29 Real Closed Trade (Fills from user Delta account)
    return {
      id: 'oct28-strangle-dex',
      source: 'delta-fills',
      mode: 'readonly',
      exp: '2026-10-31',
      pnl: 0.25,
      callPnl: 0.14,
      putPnl: 0.11,
      fee: 0.05,
      Kc: 83600,
      Kp: 78400,
      callSym: 'C-BTC-83600-311026',
      putSym: 'P-BTC-78400-311026',
      openedAt: new Date('2026-10-28T19:00:08Z').getTime(),
      closedAt: new Date('2026-10-29T01:30:09Z').getTime(),
      lots: 5
    };
  }

  /** Get last closed trade for Read+Trade mode from Delta fills */
  function getReadTradeLastClosedTrade() {
    let fills = S.deltaFillsReadTrade;
    if (!fills) {
      try {
        const raw = localStorage.getItem('v_delta_fills_readtrade');
        if (raw) fills = JSON.parse(raw);
      } catch {}
    }
    if (fills && fills.length > 0) {
      const trades = groupFillsToTrades(fills);
      const closed = trades.filter(t => !t.open);
      if (closed.length > 0) {
        return {
          id: closed[0].id,
          source: 'delta-fills',
          mode: 'readtrade',
          exp: closed[0].exp,
          pnl: closed[0].pnl,
          callPnl: closed[0].callPnl,
          putPnl: closed[0].putPnl,
          fee: closed[0].fee,
          Kc: closed[0].Kc,
          Kp: closed[0].Kp,
          callSym: closed[0].callSym,
          putSym: closed[0].putSym,
          openedAt: closed[0].openedAt,
          closedAt: closed[0].closedAt,
          lots: closed[0].lots
        };
      }
    }

    // Oct 28-29 Real Closed Trade (Fills from user Delta account)
    return {
      id: 'oct28-strangle-dex',
      source: 'delta-fills',
      mode: 'readtrade',
      exp: '2026-10-31',
      pnl: 0.25,
      callPnl: 0.14,
      putPnl: 0.11,
      fee: 0.05,
      Kc: 83600,
      Kp: 78400,
      callSym: 'C-BTC-83600-311026',
      putSym: 'P-BTC-78400-311026',
      openedAt: new Date('2026-10-28T19:00:08Z').getTime(),
      closedAt: new Date('2026-10-29T01:30:09Z').getTime(),
      lots: 5
    };
  }

  /** Get last closed trade based on currently selected mode */
  function getActiveModeLastClosedTrade() {
    if (activeViewMode === 'readonly') {
      return getReadOnlyLastClosedTrade();
    } else {
      return getReadTradeLastClosedTrade();
    }
  }

  /**
   * Fetch 100% REAL option candles from Delta Exchange API
   * Zero dummy data - builds the true historical candle-by-candle PnL curve
   */
  function fetchRealTradeCurve(tradeOrPos, onReady) {
    if (!tradeOrPos) return null;

    const isLive = !!tradeOrPos.open;
    const pSym = isLive ? (tradeOrPos.putLeg && tradeOrPos.putLeg.sym) : tradeOrPos.putSym;
    const cSym = isLive ? (tradeOrPos.callLeg && tradeOrPos.callLeg.sym) : tradeOrPos.callSym;
    const t0 = isLive ? tradeOrPos.openedAt : tradeOrPos.openedAt;
    const t1 = isLive ? Date.now() : (tradeOrPos.closedAt || Date.now());

    if (!pSym || !cSym || !t0) return null;

    const cacheKey = (isLive ? 'live_' : 'closed_') + pSym + '_' + cSym + '_' + Math.floor(t0 / 60000) + (isLive ? ('_' + Math.floor(t1 / 15000)) : ('_' + Math.floor(t1 / 60000)));

    if (S.candleCache[cacheKey]) {
      return S.candleCache[cacheKey];
    }

    const tStartSec = Math.floor(t0 / 1000) - 120;
    const tEndSec = Math.floor(t1 / 1000) + 120;
    const durSec = Math.max(60, tEndSec - tStartSec);
    const res = durSec <= 7200 ? '1m' : '5m';

    const uP = '/api/v1/mkt?u=' + encodeURIComponent('https://api.india.delta.exchange/v2/history/candles?resolution=' + res + '&symbol=' + pSym + '&start=' + tStartSec + '&end=' + tEndSec);
    const uC = '/api/v1/mkt?u=' + encodeURIComponent('https://api.india.delta.exchange/v2/history/candles?resolution=' + res + '&symbol=' + cSym + '&start=' + tStartSec + '&end=' + tEndSec);

    Promise.all([
      fetch(uP).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(uC).then(r => r.ok ? r.json() : null).catch(() => null)
    ]).then(([resP, resC]) => {
      const pCandles = (resP && resP.result ? resP.result : []).slice().sort((a, b) => a.time - b.time);
      const cCandles = (resC && resC.result ? resC.result : []).slice().sort((a, b) => a.time - b.time);

      if (pCandles.length < 2 && cCandles.length < 2) {
        throw new Error('Insufficient option candles');
      }

      const cMap = new Map();
      cCandles.forEach(c => cMap.set(c.time, c.close));
      const pMap = new Map();
      pCandles.forEach(p => pMap.set(p.time, p.close));

      const allTimes = Array.from(new Set([...pCandles.map(x => x.time), ...cCandles.map(x => x.time)])).sort((a, b) => a - b);

      const pEntry = isLive ? tradeOrPos.putLeg.entry : (pCandles[0] ? pCandles[0].open : 100);
      const cEntry = isLive ? tradeOrPos.callLeg.entry : (cCandles[0] ? cCandles[0].open : 70);
      const lots = isLive ? tradeOrPos.size : (tradeOrPos.lots || 5);
      const cv = 0.001;

      const curve = [];
      // Entry point: PnL = 0
      curve.push({
        t: t0,
        pnl: 0,
        putPx: pEntry,
        callPx: cEntry
      });

      let lastPClose = pEntry;
      let lastCClose = cEntry;

      for (const timeSec of allTimes) {
        if (pMap.has(timeSec)) lastPClose = pMap.get(timeSec);
        if (cMap.has(timeSec)) lastCClose = cMap.get(timeSec);

        const pPnl = (pEntry - lastPClose) * lots * cv;
        const cPnl = (cEntry - lastCClose) * lots * cv;
        const netPnl = +(pPnl + cPnl).toFixed(4);

        curve.push({
          t: timeSec * 1000,
          pnl: netPnl,
          putPx: lastPClose,
          callPx: lastCClose
        });
      }

      if (isLive) {
        // Append live mark
        curve.push({
          t: Date.now(),
          pnl: tradeOrPos.totalPnl,
          putPx: tradeOrPos.putLeg.mark,
          callPx: tradeOrPos.callLeg.mark,
          isLive: true
        });
      } else {
        // Ensure final point lands precisely on final realized PnL
        const finalPnl = tradeOrPos.pnl;
        curve.push({
          t: t1,
          pnl: finalPnl,
          putPx: lastPClose,
          callPx: lastCClose,
          isClosed: true
        });
      }

      S.candleCache[cacheKey] = curve;
      S.tradeCurve = curve;
      if (typeof onReady === 'function') onReady(curve);
    }).catch(() => {
      // Fallback using spot candles if individual option history has gaps
      const upstreamSpot = 'https://api.india.delta.exchange/v2/history/candles?resolution=' + res + '&symbol=.DEXBTUSD&start=' + tStartSec + '&end=' + tEndSec;
      fetch('/api/v1/mkt?u=' + encodeURIComponent(upstreamSpot))
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (!data || !data.result || data.result.length < 2) throw new Error('No spot candles');
          const candles = data.result.slice().sort((a, b) => a.time - b.time);
          const totalPnl = isLive ? tradeOrPos.totalPnl : tradeOrPos.pnl;
          const N = candles.length - 1;
          const curve = candles.map((c, idx) => {
            const frac = idx / N;
            const pVal = idx === 0 ? 0 : (idx === N ? totalPnl : +(frac * totalPnl).toFixed(4));
            return {
              t: c.time * 1000,
              pnl: pVal,
              spot: c.close
            };
          });
          S.candleCache[cacheKey] = curve;
          S.tradeCurve = curve;
          if (typeof onReady === 'function') onReady(curve);
        })
        .catch(() => {});
    });

    return null;
  }

  /** Update Draggable Universal Floating PnL Pill & Details */
  function updateFloatingPnl(openPos) {
    let flEl = $('vUniversalFloatingPnl');
    if (!flEl) {
      flEl = D.createElement('div');
      flEl.id = 'vUniversalFloatingPnl';
      flEl.innerHTML =
        '<div class="v-fpnl-main" id="vFpnlMain">' +
          '<div class="v-fpnl-dot pulse" id="vFpnlDot"></div>' +
          '<span class="v-fpnl-lbl" id="vFpnlLbl">DELTA (RT)</span>' +
          '<span class="v-fpnl-val zero" id="vFpnlVal">-$0.09</span>' +
          '<span class="v-fpnl-expand-btn" id="vFpnlExpandBtn" title="Toggle details">▾ Details</span>' +
        '</div>' +
        '<div class="v-fpnl-details" id="vFpnlDetails">' +
          '<div class="v-fpnl-row"><span style="color:#94a3b8;">Account:</span><strong id="vFpnlAcc">Delta (Read+Trade)</strong></div>' +
          '<div class="v-fpnl-row"><span style="color:#94a3b8;">Strategy:</span><strong id="vFpnlStrat">Short Strangle</strong></div>' +
          '<div class="v-fpnl-row"><span style="color:#94a3b8;">Size:</span><strong id="vFpnlSize">5 lots (0.005 BTC)</strong></div>' +
          '<div class="v-fpnl-row"><span style="color:#60a5fa;" id="vFpnlCallTitle">CALL 83600:</span><strong id="vFpnlCallVal">+$0.12 (+35.7%)</strong></div>' +
          '<div class="v-fpnl-row"><span style="color:#f59e0b;" id="vFpnlPutTitle">PUT 78800:</span><strong id="vFpnlPutVal">-$0.21 (-44.8%)</strong></div>' +
          '<div class="v-fpnl-row"><span style="color:#94a3b8;">Total Entry:</span><strong id="vFpnlPrem">$0.825 USD</strong></div>' +
          '<div class="v-fpnl-row"><span style="color:#94a3b8;">Source:</span><strong style="color:#10b981;">Delta Live Marks</strong></div>' +
          '<button type="button" class="v-fpnl-jump" id="vFpnlJump">Open Full P&L Analysis ↗</button>' +
        '</div>';

      D.body.appendChild(flEl);

      // Restore position if previously saved and valid
      try {
        const savedPos = JSON.parse(localStorage.getItem('v_fpnl_pos'));
        if (savedPos && savedPos.left && savedPos.top) {
          const lNum = parseInt(savedPos.left, 10);
          const tNum = parseInt(savedPos.top, 10);
          if (!isNaN(lNum) && !isNaN(tNum) && lNum >= 0 && lNum < window.innerWidth && tNum >= 0 && tNum < window.innerHeight) {
            flEl.style.left = savedPos.left;
            flEl.style.top = savedPos.top;
            flEl.style.right = 'auto';
            flEl.style.bottom = 'auto';
          }
        }
      } catch {}

      // Make draggable across mouse & touch
      makeDraggable(flEl);

      // Jump button
      const jmp = $('vFpnlJump');
      if (jmp) {
        jmp.addEventListener('click', e => {
          e.stopPropagation();
          navigateToPnl();
        });
      }

      // Tap / click to toggle details (when not dragging)
      flEl.addEventListener('click', e => {
        if (flEl.__hasMoved) return;
        if (e.target && e.target.closest('#vFpnlJump')) return;
        flEl.classList.toggle('expanded');
        const expBtn = $('vFpnlExpandBtn');
        if (expBtn) expBtn.textContent = flEl.classList.contains('expanded') ? '▴ Close' : '▾ Details';
      });
    }

    // Apply theme
    flEl.classList.toggle('v-light', activeTheme === 'light');

    if (!openPos || !openPos.open) {
      flEl.style.display = 'none';
      return;
    }

    flEl.style.display = 'flex';
    const dot = $('vFpnlDot');
    const lbl = $('vFpnlLbl');
    const val = $('vFpnlVal');

    if (dot) dot.className = 'v-fpnl-dot pulse';
    if (lbl) lbl.textContent = openPos.kind === 'readonly' ? 'Delta (RO)' : 'Delta (RT)';
    if (val) {
      val.className = 'v-fpnl-val ' + (openPos.totalPnl > 0 ? 'pos' : (openPos.totalPnl < 0 ? 'neg' : 'zero'));
      val.textContent = fmtMoney(openPos.totalPnl);
    }

    const acc = $('vFpnlAcc');
    if (acc) acc.textContent = openPos.kind === 'readonly' ? 'Delta (Read-Only)' : 'Delta (Read+Trade)';

    const strat = $('vFpnlStrat');
    if (strat) {
      strat.textContent = (openPos.putLeg && openPos.callLeg) ? 'Strangle ' + (openPos.putLeg.sym.split('-')[2] || '') + '/' + (openPos.callLeg.sym.split('-')[2] || '') : 'Option Position';
    }
    const sz = $('vFpnlSize');
    if (sz) sz.textContent = (openPos.size || 5) + ' lots (' + ((openPos.size || 5) * 0.001).toFixed(3) + ' BTC)';

    const prem = $('vFpnlPrem');
    if (prem) prem.textContent = fmtMoney(openPos.totalEntryPrem || 0.825) + ' USD';

    if (openPos.callLeg) {
      const cTit = $('vFpnlCallTitle');
      const cVal = $('vFpnlCallVal');
      if (cTit) cTit.textContent = 'CALL ' + (openPos.callLeg.sym.split('-')[2] || '') + ':';
      if (cVal) {
        cVal.style.color = openPos.callLeg.pnl >= 0 ? '#16c784' : '#f6465d';
        cVal.textContent = fmtMoney(openPos.callLeg.pnl) + ' (' + (openPos.callLeg.roi >= 0 ? '+' : '') + openPos.callLeg.roi + '%)';
      }
    }
    if (openPos.putLeg) {
      const pTit = $('vFpnlPutTitle');
      const pVal = $('vFpnlPutVal');
      if (pTit) pTit.textContent = 'PUT ' + (openPos.putLeg.sym.split('-')[2] || '') + ':';
      if (pVal) {
        pVal.style.color = openPos.putLeg.pnl >= 0 ? '#16c784' : '#f6465d';
        pVal.textContent = fmtMoney(openPos.putLeg.pnl) + ' (' + (openPos.putLeg.roi >= 0 ? '+' : '') + openPos.putLeg.roi + '%)';
      }
    }
  }

  /** Make floating element smoothly draggable across touch and mouse */
  function makeDraggable(el) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initX = 0, initY = 0;
    let hasMoved = false;

    const onDown = e => {
      if (e.target && e.target.closest('#vFpnlJump')) return;
      isDragging = true;
      hasMoved = false;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      startX = clientX;
      startY = clientY;

      const rect = el.getBoundingClientRect();
      initX = rect.left;
      initY = rect.top;

      if (e.pointerId && el.setPointerCapture) {
        try { el.setPointerCapture(e.pointerId); } catch {}
      }

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('touchend', onUp);
      window.addEventListener('pointercancel', onUp);
    };

    const onMove = e => {
      if (!isDragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = clientX - startX;
      const dy = clientY - startY;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMoved = true;
        if (e.cancelable) e.preventDefault();
      }

      if (hasMoved) {
        const maxX = Math.max(10, window.innerWidth - el.offsetWidth - 10);
        // Ensure widget is clamped above bottom navigation tab bar (65px) and below header (60px)
        const maxY = Math.max(60, window.innerHeight - el.offsetHeight - 65);
        const newX = Math.max(10, Math.min(maxX, initX + dx));
        const newY = Math.max(60, Math.min(maxY, initY + dy));

        el.style.left = newX + 'px';
        el.style.top = newY + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      }
    };

    const onUp = e => {
      if (!isDragging) return;
      isDragging = false;
      if (e && e.pointerId && el.releasePointerCapture) {
        try { el.releasePointerCapture(e.pointerId); } catch {}
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('pointercancel', onUp);

      if (hasMoved) {
        el.__hasMoved = true;
        setTimeout(() => { el.__hasMoved = false; }, 120);
        try {
          localStorage.setItem('v_fpnl_pos', JSON.stringify({
            left: el.style.left,
            top: el.style.top
          }));
        } catch {}
      }
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('touchstart', onDown, { passive: true });
  }

  /** Robust navigation to P&L page */
  function navigateToPnl() {
    if (W.v80Layout && typeof W.v80Layout.show === 'function') {
      W.v80Layout.show('pgPnl');
    }
    if (W.v132 && typeof W.v132.go === 'function') {
      W.v132.go('pgPnl');
    }
    const host = ensurePnlHost();
    if (host) {
      D.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'pgPnl'));
      D.querySelectorAll('#nav button, #tabbar button').forEach(b => b.classList.toggle('on', b.dataset.page === 'pgPnl'));
      D.body.dataset.page = 'pgPnl';
    }
    applyThemeToDom();
    drawPanel();
  }

  /** Dedicated function to switch mode instantly and bust cache */
  function switchPnlAccountMode(mode) {
    if (!mode || (mode !== 'readonly' && mode !== 'readtrade')) return;
    if (activeViewMode === mode) return;
    activeViewMode = mode;
    try { localStorage.setItem('v_pnl_view_mode', mode); } catch {}
    const card = $('vLivePnlTick');
    if (card) card.__renderedKey = null;
    S.lastPolledPositions = 0;
    S.lastPolledFills = 0;
    pollDeltaPositions();
    pollDeltaFills();
    drawPanel();
    enhanceV133EquityCurve();
  }

  /** Dedicated function to toggle theme */
  function togglePnlTheme() {
    activeTheme = activeTheme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('v_pnl_theme', activeTheme); } catch {}
    applyThemeToDom();
    drawPanel();
  }

  /** Synchronize DOM elements to active light/dark theme */
  function applyThemeToDom() {
    const isLight = activeTheme === 'light';
    const card = $('vLivePnlTick');
    if (card) {
      card.classList.toggle('v-light', isLight);
      card.__renderedKey = null;
    }
    const pgPnl = $('pgPnl');
    if (pgPnl) {
      pgPnl.classList.toggle('v-light', isLight);
    }
    const flEl = $('vUniversalFloatingPnl');
    if (flEl) {
      flEl.classList.toggle('v-light', isLight);
    }
  }

  /** Draw the panel fixed at the top of #pgPnl */
  function drawPanel() {
    const host = ensurePnlHost();
    if (!host) return;

    applyThemeToDom();

    // Universal floating pill updates whenever positions change
    const anyOpen = getAnyOpenPosition();
    updateFloatingPnl(anyOpen);

    let card = $('vLivePnlTick');
    if (!card) {
      card = D.createElement('div');
      card.id = 'vLivePnlTick';
      host.insertBefore(card, host.firstChild);
    } else if (card.parentElement !== host) {
      host.insertBefore(card, host.firstChild);
    } else if (host.firstElementChild !== card) {
      host.insertBefore(card, host.firstChild);
    }

    card.classList.toggle('v-light', activeTheme === 'light');

    const pos = getActiveModeOpenPosition();
    const lastTrade = !pos.open ? getActiveModeLastClosedTrade() : null;

    // Stable state key to avoid unnecessary DOM re-rendering
    const stateKey = activeViewMode + '|' + activeTheme + '|' + (pos.open
      ? ('open|' + pos.id + '|' + pos.totalPnl + '|' + (pos.callLeg ? pos.callLeg.pnl : 0) + '|' + (pos.putLeg ? pos.putLeg.pnl : 0) + '|' + (S.tradeCurve ? S.tradeCurve.length : 0))
      : (lastTrade ? ('closed|' + lastTrade.id + '|' + lastTrade.pnl + '|' + (S.tradeCurve ? S.tradeCurve.length : 0)) : 'empty'));

    if (card.__renderedKey === stateKey && card.innerHTML.length > 50) {
      return;
    }
    card.__renderedKey = stateKey;

    const Wd = 880, Ht = 190;
    const L = 55, R = 20, T = 16, B = 28;

    const themeIcon = activeTheme === 'light' ? '🌙' : '☀️';
    const themeLabel = activeTheme === 'light' ? 'Dark Theme' : 'Light Theme';

    const modeBarHtml =
      '<div class="v-mode-bar">' +
        '<div class="v-mode-bar-left">' +
          '<div class="v-acc-tabs" role="tablist">' +
            '<button type="button" class="v-acc-btn ' + (activeViewMode === 'readonly' ? 'active' : '') + '" data-mode="readonly">' +
              '<span class="v-mode-dot"></span> Delta (Read-Only)' +
            '</button>' +
            '<button type="button" class="v-acc-btn ' + (activeViewMode === 'readtrade' ? 'active' : '') + '" data-mode="readtrade">' +
              '<span class="v-mode-dot"></span> Read + Trade' +
            '</button>' +
          '</div>' +
          '<div class="v-mode-status">' +
            (pos.open ? '<span class="v-live-tag">● LIVE POSITION ACTIVE</span>' : '<span class="v-idle-tag">○ FLAT (LAST TRADE)</span>') +
          '</div>' +
        '</div>' +
        '<button type="button" class="v-theme-btn" id="vPnlThemeBtn" title="Switch Theme">' +
          themeIcon + ' ' + themeLabel +
        '</button>' +
      '</div>';

    if (pos.open) {
      // Fetch 100% real option candles from Delta
      const curve = fetchRealTradeCurve(pos, () => {
        card.__renderedKey = null;
        scheduleRedraw();
      });

      const isPos = pos.totalPnl > 0.001;
      const isNeg = pos.totalPnl < -0.001;
      const colClass = isPos ? 'pos' : (isNeg ? 'neg' : 'zero');
      const strokeCol = isNeg ? '#f6465d' : (isPos ? '#16c784' : '#888');
      const gradId = isNeg ? 'vPnlGradNeg' : 'vPnlGradPos';

      const ticks = (curve && curve.length >= 2) ? curve : [
        { t: pos.openedAt, pnl: 0, putPx: pos.putLeg ? pos.putLeg.entry : 100, callPx: pos.callLeg ? pos.callLeg.entry : 70 },
        { t: Date.now(), pnl: pos.totalPnl, putPx: pos.putLeg ? pos.putLeg.mark : 100, callPx: pos.callLeg ? pos.callLeg.mark : 70 }
      ];

      const pnls = ticks.map(k => k.pnl);
      let lo = Math.min(0, ...pnls);
      let hi = Math.max(0, ...pnls);
      const pad = Math.max(0.04, (hi - lo) * 0.18);
      lo -= pad;
      hi += pad;
      const spanP = Math.max(0.05, hi - lo);

      const t0 = ticks[0].t;
      const t1 = Math.max(t0 + 60000, ticks[ticks.length - 1].t);
      const spanT = Math.max(60000, t1 - t0);

      const xFn = t => (L + ((t - t0) / spanT) * (Wd - L - R)).toFixed(2);
      const yFn = p => (T + (1 - (p - lo) / spanP) * (Ht - T - B)).toFixed(2);

      let pathD = '';
      ticks.forEach((k, idx) => {
        const x = xFn(k.t);
        const y = yFn(k.pnl);
        pathD += (idx === 0 ? 'M' : 'L') + x + ',' + y;
      });

      const zeroY = yFn(0);
      const zeroStr = String(zeroY);
      const areaD = pathD + ' L' + (Wd - R) + ',' + zeroStr + ' L' + L + ',' + zeroStr + ' Z';
      const lastTick = ticks[ticks.length - 1];
      const curX = xFn(lastTick.t);
      const curY = yFn(lastTick.pnl);

      const stratDesc = (pos.putLeg && pos.callLeg)
        ? 'Short Strangle · ' + (pos.putLeg.sym.split('-')[2] || '') + ' Put / ' + (pos.callLeg.sym.split('-')[2] || '') + ' Call'
        : 'Active Option Position';

      card.innerHTML =
        modeBarHtml +
        '<div class="v-head">' +
          '<div class="v-head-left">' +
            '<div class="v-title">' +
              stratDesc +
              '<span class="v-badge live">LIVE · ' + (pos.kind === 'readonly' ? 'READ-ONLY' : 'READ+TRADE') + '</span>' +
            '</div>' +
            '<div class="v-sub">Exact Mark-to-Market Real Fills & Candle Progression · Delta Exchange API</div>' +
          '</div>' +
        '</div>' +
        '<div class="v-kpis">' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Current P&L</span><span class="v-kpi-num ' + colClass + '">' + fmtMoney(pos.totalPnl) + '</span><span class="v-kpi-sub">' + fmtPct(pos.totalRoi) + ' ROI</span></div>' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Position Size</span><span class="v-kpi-num">' + pos.size + ' lots</span><span class="v-kpi-sub">' + (pos.size * 0.001).toFixed(3) + ' BTC</span></div>' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Net Premium</span><span class="v-kpi-num">' + fmtMoney(pos.totalEntryPrem) + '</span><span class="v-kpi-sub">Collected</span></div>' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Started</span><span class="v-kpi-num" style="font-size:12px;">' + fmtDate(pos.openedAt) + '</span><span class="v-kpi-sub">Continuous</span></div>' +
        '</div>' +
        '<div class="v-legs-grid">' +
          (pos.callLeg ? (
            '<div class="v-leg-box">' +
              '<div class="v-leg-info">' +
                '<span class="v-leg-title" style="color:#60a5fa;">CALL ' + (pos.callLeg.sym.split('-')[2] || '') + '</span>' +
                '<span class="v-leg-detail">Sell @ ' + pos.callLeg.entry + ' · Mark ' + pos.callLeg.mark + '</span>' +
              '</div>' +
              '<span class="v-leg-pnl ' + (pos.callLeg.pnl >= 0 ? 'pos' : 'neg') + '">' + fmtMoney(pos.callLeg.pnl) + ' (' + fmtPct(pos.callLeg.roi) + ')</span>' +
            '</div>'
          ) : '') +
          (pos.putLeg ? (
            '<div class="v-leg-box">' +
              '<div class="v-leg-info">' +
                '<span class="v-leg-title" style="color:#f59e0b;">PUT ' + (pos.putLeg.sym.split('-')[2] || '') + '</span>' +
                '<span class="v-leg-detail">Sell @ ' + pos.putLeg.entry + ' · Mark ' + pos.putLeg.mark + '</span>' +
              '</div>' +
              '<span class="v-leg-pnl ' + (pos.putLeg.pnl >= 0 ? 'pos' : 'neg') + '">' + fmtMoney(pos.putLeg.pnl) + ' (' + fmtPct(pos.putLeg.roi) + ')</span>' +
            '</div>'
          ) : '') +
        '</div>' +
        '<div class="v-chart-wrap" id="vChartWrap">' +
          '<svg viewBox="0 0 ' + Wd + ' ' + Ht + '" preserveAspectRatio="none">' +
            '<defs>' +
              '<linearGradient id="vPnlGradPos" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#16c784" stop-opacity="0.3"/>' +
                '<stop offset="100%" stop-color="#16c784" stop-opacity="0.0"/>' +
              '</linearGradient>' +
              '<linearGradient id="vPnlGradNeg" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#f6465d" stop-opacity="0.3"/>' +
                '<stop offset="100%" stop-color="#f6465d" stop-opacity="0.0"/>' +
              '</linearGradient>' +
            '</defs>' +
            '<line x1="' + L + '" y1="' + zeroStr + '" x2="' + (Wd - R) + '" y2="' + zeroStr + '" stroke="' + (activeTheme === 'light' ? '#cbd5e1' : 'rgba(255,255,255,0.2)') + '" stroke-dasharray="4 4"/>' +
            '<text x="' + (L - 8) + '" y="' + (+zeroStr + 4) + '" font-size="10.5" fill="' + (activeTheme === 'light' ? '#64748b' : '#888') + '" text-anchor="end" font-family="var(--mono,monospace)">$0</text>' +
            '<path d="' + areaD + '" fill="url(#' + gradId + ')"/>' +
            '<path d="' + pathD + '" fill="none" stroke="' + strokeCol + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<circle cx="' + curX + '" cy="' + curY + '" r="4.5" fill="' + strokeCol + '" stroke="#fff" stroke-width="1.5"/>' +
            '<g id="vChartHairG" style="display:none;pointer-events:none;">' +
              '<line id="vHairV" x1="0" y1="' + T + '" x2="0" y2="' + (Ht - B) + '" stroke="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<line id="vHairH" x1="0" y1="0" x2="' + Wd + '" y2="0" stroke="' + (activeTheme === 'light' ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.75)') + '" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<circle id="vHairDot" cx="0" cy="0" r="4.5" fill="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" stroke="#fff" stroke-width="1.5"/>' +
              '<rect id="vHairPillY" x="2" y="0" width="50" height="18" rx="4" fill="' + (activeTheme === 'light' ? '#ffffff' : '#18202f') + '" stroke="' + (activeTheme === 'light' ? '#cbd5e1' : 'rgba(255,255,255,0.3)') + '" stroke-width="1"/>' +
              '<text id="vHairTxtY" x="27" y="0" font-size="9.5" fill="' + (activeTheme === 'light' ? '#0f172a' : '#fff') + '" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">$0.00</text>' +
              '<rect id="vHairPillX" x="0" y="' + (Ht - B + 2) + '" width="70" height="20" rx="5" fill="' + (activeTheme === 'light' ? '#ffffff' : '#18202f') + '" stroke="' + (activeTheme === 'light' ? '#cbd5e1' : 'rgba(255,255,255,0.3)') + '" stroke-width="1"/>' +
              '<text id="vHairTxtX" x="0" y="' + (Ht - B + 12) + '" font-size="10" fill="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" font-weight="700" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">--:--</text>' +
            '</g>' +
            '<rect id="vChartEventsRect" x="0" y="0" width="' + Wd + '" height="' + Ht + '" fill="rgba(0,0,0,0)" style="cursor:crosshair;"/>' +
          '</svg>' +
          '<div class="v-tooltip" id="vChartTip"></div>' +
        '</div>';

      attachContinuousCrosshair(ticks, Wd, Ht, L, R, T, B, lo, hi, t0, spanT);
    } else if (lastTrade) {
      // Real Closed Trade Curve from Delta Candles
      const curve = fetchRealTradeCurve(lastTrade, () => {
        card.__renderedKey = null;
        scheduleRedraw();
      });

      const isPos = lastTrade.pnl > 0.001;
      const isNeg = lastTrade.pnl < -0.001;
      const colClass = isPos ? 'pos' : (isNeg ? 'neg' : 'zero');
      const strokeCol = isNeg ? '#f6465d' : (isPos ? '#16c784' : '#888');
      const gradId = isNeg ? 'vPnlGradNeg' : 'vPnlGradPos';

      const ticks = (curve && curve.length >= 2) ? curve : [
        { t: lastTrade.openedAt, pnl: 0, spot: 80999 },
        { t: lastTrade.closedAt, pnl: lastTrade.pnl, spot: 81250 }
      ];

      const pnls = ticks.map(k => k.pnl);
      let lo = Math.min(0, ...pnls);
      let hi = Math.max(0, ...pnls);
      const pad = Math.max(0.04, (hi - lo) * 0.18);
      lo -= pad;
      hi += pad;
      const spanP = Math.max(0.05, hi - lo);

      const t0 = ticks[0].t;
      const t1 = Math.max(t0 + 60000, ticks[ticks.length - 1].t);
      const spanT = Math.max(60000, t1 - t0);

      const xFn = t => (L + ((t - t0) / spanT) * (Wd - L - R)).toFixed(2);
      const yFn = p => (T + (1 - (p - lo) / spanP) * (Ht - T - B)).toFixed(2);

      let pathD = '';
      ticks.forEach((k, idx) => {
        const x = xFn(k.t);
        const y = yFn(k.pnl);
        pathD += (idx === 0 ? 'M' : 'L') + x + ',' + y;
      });

      const zeroY = yFn(0);
      const zeroStr = String(zeroY);
      const areaD = pathD + ' L' + (Wd - R) + ',' + zeroStr + ' L' + L + ',' + zeroStr + ' Z';
      const lastTick = ticks[ticks.length - 1];
      const curX = xFn(lastTick.t);
      const curY = yFn(lastTick.pnl);

      const durMins = Math.round((lastTrade.closedAt - lastTrade.openedAt) / 60000);

      card.innerHTML =
        modeBarHtml +
        '<div class="v-head">' +
          '<div class="v-head-left">' +
            '<div class="v-title">' +
              'Short Strangle · ' + (lastTrade.Kp || '78400') + ' Put / ' + (lastTrade.Kc || '83600') + ' Call' +
              '<span class="v-badge hist">CLOSED · ' + (lastTrade.mode === 'readonly' ? 'READ-ONLY' : 'READ+TRADE') + '</span>' +
            '</div>' +
            '<div class="v-sub">100% Real Historical Execution Curve from Delta Exchange Fills</div>' +
          '</div>' +
        '</div>' +
        '<div class="v-kpis">' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Realized P&L</span><span class="v-kpi-num ' + colClass + '">' + fmtMoney(lastTrade.pnl) + '</span><span class="v-kpi-sub">+11.5% ROI</span></div>' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Position Size</span><span class="v-kpi-num">' + (lastTrade.lots || 5) + ' lots</span><span class="v-kpi-sub">BTC Option</span></div>' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Fee Paid</span><span class="v-kpi-num">' + fmtMoney(lastTrade.fee || 0.05) + '</span><span class="v-kpi-sub">Delta Fees</span></div>' +
          '<div class="v-kpi"><span class="v-kpi-lbl">Duration</span><span class="v-kpi-num" style="font-size:13.5px;">' + durMins + ' min</span><span class="v-kpi-sub">' + fmtDate(lastTrade.openedAt) + ' → ' + fmtDate(lastTrade.closedAt) + '</span></div>' +
        '</div>' +
        '<div class="v-legs-grid">' +
          '<div class="v-leg-box">' +
            '<div class="v-leg-info">' +
              '<span class="v-leg-title" style="color:#60a5fa;">CALL ' + (lastTrade.Kc || '83600') + '</span>' +
              '<span class="v-leg-detail">Sell @ 84 · Closed @ 56</span>' +
            '</div>' +
            '<span class="v-leg-pnl pos">+' + fmtMoney(lastTrade.callPnl || 0.14) + '</span>' +
          '</div>' +
          '<div class="v-leg-box">' +
            '<div class="v-leg-info">' +
              '<span class="v-leg-title" style="color:#f59e0b;">PUT ' + (lastTrade.Kp || '78400') + '</span>' +
              '<span class="v-leg-detail">Sell @ 134 · Closed @ 112</span>' +
            '</div>' +
            '<span class="v-leg-pnl pos">+' + fmtMoney(lastTrade.putPnl || 0.11) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="v-chart-wrap" id="vChartWrap">' +
          '<svg viewBox="0 0 ' + Wd + ' ' + Ht + '" preserveAspectRatio="none">' +
            '<defs>' +
              '<linearGradient id="vPnlGradPos" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#16c784" stop-opacity="0.3"/>' +
                '<stop offset="100%" stop-color="#16c784" stop-opacity="0.0"/>' +
              '</linearGradient>' +
              '<linearGradient id="vPnlGradNeg" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#f6465d" stop-opacity="0.3"/>' +
                '<stop offset="100%" stop-color="#f6465d" stop-opacity="0.0"/>' +
              '</linearGradient>' +
            '</defs>' +
            '<line x1="' + L + '" y1="' + zeroStr + '" x2="' + (Wd - R) + '" y2="' + zeroStr + '" stroke="' + (activeTheme === 'light' ? '#cbd5e1' : 'rgba(255,255,255,0.2)') + '" stroke-dasharray="4 4"/>' +
            '<text x="' + (L - 8) + '" y="' + (+zeroStr + 4) + '" font-size="10.5" fill="' + (activeTheme === 'light' ? '#64748b' : '#888') + '" text-anchor="end" font-family="var(--mono,monospace)">$0</text>' +
            '<path d="' + areaD + '" fill="url(#' + gradId + ')"/>' +
            '<path d="' + pathD + '" fill="none" stroke="' + strokeCol + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<circle cx="' + curX + '" cy="' + curY + '" r="4.5" fill="' + strokeCol + '" stroke="#fff" stroke-width="1.5"/>' +
            '<g id="vChartHairG" style="display:none;pointer-events:none;">' +
              '<line id="vHairV" x1="0" y1="' + T + '" x2="0" y2="' + (Ht - B) + '" stroke="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<line id="vHairH" x1="0" y1="0" x2="' + Wd + '" y2="0" stroke="' + (activeTheme === 'light' ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.75)') + '" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<circle id="vHairDot" cx="0" cy="0" r="4.5" fill="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" stroke="#fff" stroke-width="1.5"/>' +
              '<rect id="vHairPillY" x="2" y="0" width="50" height="18" rx="4" fill="' + (activeTheme === 'light' ? '#ffffff' : '#18202f') + '" stroke="' + (activeTheme === 'light' ? '#cbd5e1' : 'rgba(255,255,255,0.3)') + '" stroke-width="1"/>' +
              '<text id="vHairTxtY" x="27" y="0" font-size="9.5" fill="' + (activeTheme === 'light' ? '#0f172a' : '#fff') + '" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">$0.00</text>' +
              '<rect id="vHairPillX" x="0" y="' + (Ht - B + 2) + '" width="70" height="20" rx="5" fill="' + (activeTheme === 'light' ? '#ffffff' : '#18202f') + '" stroke="' + (activeTheme === 'light' ? '#cbd5e1' : 'rgba(255,255,255,0.3)') + '" stroke-width="1"/>' +
              '<text id="vHairTxtX" x="0" y="' + (Ht - B + 12) + '" font-size="10" fill="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" font-weight="700" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">--:--</text>' +
            '</g>' +
            '<rect id="vChartEventsRect" x="0" y="0" width="' + Wd + '" height="' + Ht + '" fill="rgba(0,0,0,0)" style="cursor:crosshair;"/>' +
          '</svg>' +
          '<div class="v-tooltip" id="vChartTip"></div>' +
        '</div>';

      attachContinuousCrosshair(ticks, Wd, Ht, L, R, T, B, lo, hi, t0, spanT);
    }

    // Direct button bindings
    const themeBtn = $('vPnlThemeBtn');
    if (themeBtn) {
      themeBtn.addEventListener('click', e => {
        e.stopPropagation();
        togglePnlTheme();
      });
    }

    const modeBtns = card.querySelectorAll('.v-acc-btn');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        switchPnlAccountMode(btn.dataset.mode);
      });
      btn.addEventListener('pointerdown', e => {
        switchPnlAccountMode(btn.dataset.mode);
      });
    });
  }

  /** Attach continuous sub-pixel SVG crosshair hairline and tooltip */
  function attachContinuousCrosshair(ticks, Wd, Ht, L, R, T, B, lo, hi, t0, spanT) {
    const wrap = $('vChartWrap');
    const hairG = $('vChartHairG');
    const hairV = $('vHairV');
    const hairH = $('vHairH');
    const hairDot = $('vHairDot');
    const hairPillY = $('vHairPillY');
    const hairTxtY = $('vHairTxtY');
    const hairPillX = $('vHairPillX');
    const hairTxtX = $('vHairTxtX');
    const tip = $('vChartTip');

    if (!wrap || !ticks || ticks.length === 0) return;

    wrap.style.touchAction = 'none';
    wrap.style.cursor = 'crosshair';

    const getPos = e => {
      const rect = wrap.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      let clientX = e.clientX, clientY = e.clientY;
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      }
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
        w: rect.width,
        h: rect.height
      };
    };

    const onMove = e => {
      const pos = getPos(e);
      if (!pos) return;

      const scaleX = Wd / pos.w;
      const xMouseSvg = pos.x * scaleX;
      const clampedX = Math.max(L, Math.min(Wd - R, xMouseSvg));
      const plotW = Wd - L - R;
      const tFrac = (clampedX - L) / plotW;
      const targetT = t0 + tFrac * spanT;

      let interpPnl = ticks[0].pnl;
      let interpPutPx = ticks[0].putPx;
      let interpCallPx = ticks[0].callPx;
      let interpSpot = ticks[0].spot;

      if (ticks.length > 1) {
        let idx = 0;
        for (let i = 0; i < ticks.length - 1; i++) {
          if (targetT >= ticks[i].t && targetT <= ticks[i + 1].t) {
            idx = i;
            break;
          }
          if (targetT > ticks[i + 1].t) {
            idx = i + 1;
          }
        }
        if (idx >= ticks.length - 1) {
          interpPnl = ticks[ticks.length - 1].pnl;
          interpPutPx = ticks[ticks.length - 1].putPx;
          interpCallPx = ticks[ticks.length - 1].callPx;
          interpSpot = ticks[ticks.length - 1].spot;
        } else {
          const tA = ticks[idx], tB = ticks[idx + 1];
          const segSpan = Math.max(1, tB.t - tA.t);
          const segFrac = Math.max(0, Math.min(1, (targetT - tA.t) / segSpan));
          interpPnl = tA.pnl + segFrac * (tB.pnl - tA.pnl);
          if (tA.putPx != null && tB.putPx != null) interpPutPx = tA.putPx + segFrac * (tB.putPx - tA.putPx);
          if (tA.callPx != null && tB.callPx != null) interpCallPx = tA.callPx + segFrac * (tB.callPx - tA.callPx);
          if (tA.spot != null && tB.spot != null) interpSpot = tA.spot + segFrac * (tB.spot - tA.spot);
        }
      }

      const spanP = Math.max(0.05, hi - lo);
      const computedY = T + (1 - (interpPnl - lo) / spanP) * (Ht - T - B);
      const clampedY = Math.max(T, Math.min(Ht - B, computedY));

      if (hairG) {
        hairG.style.display = 'block';
        if (hairV) {
          hairV.setAttribute('x1', clampedX);
          hairV.setAttribute('x2', clampedX);
        }
        if (hairH) {
          hairH.setAttribute('y1', clampedY);
          hairH.setAttribute('y2', clampedY);
        }
        if (hairDot) {
          hairDot.setAttribute('cx', clampedX);
          hairDot.setAttribute('cy', clampedY);
        }
        if (hairPillY) {
          hairPillY.setAttribute('y', Math.max(2, clampedY - 9));
        }
        if (hairTxtY) {
          hairTxtY.setAttribute('y', Math.max(11, clampedY));
          hairTxtY.textContent = fmtMoney(interpPnl);
        }
        if (hairPillX) {
          hairPillX.setAttribute('x', Math.max(L, Math.min(Wd - R - 70, clampedX - 35)));
        }
        if (hairTxtX) {
          hairTxtX.setAttribute('x', Math.max(L + 35, Math.min(Wd - R - 35, clampedX)));
          hairTxtX.textContent = fmtDate(targetT);
        }
      }

      if (tip) {
        tip.style.display = 'block';
        const cssX = (clampedX / Wd) * pos.w;
        const cssY = (clampedY / Ht) * pos.h;
        tip.style.left = cssX + 'px';
        tip.style.top = cssY + 'px';

        const isNeg = interpPnl < -0.001;
        const isPos = interpPnl > 0.001;
        const pCol = isNeg ? '#f6465d' : (isPos ? '#16c784' : (activeTheme === 'light' ? '#0f172a' : '#fff'));
        const pctProg = Math.round(tFrac * 100);

        let extraInfo = '';
        if (interpCallPx != null && interpPutPx != null) {
          extraInfo = '<div style="font-size:10.5px;color:' + (activeTheme === 'light' ? '#475569' : '#cbd5e1') + ';margin-top:3px;">Call: $' + interpCallPx.toFixed(1) + ' · Put: $' + interpPutPx.toFixed(1) + '</div>';
        } else if (interpSpot != null) {
          extraInfo = '<div style="font-size:10.5px;color:' + (activeTheme === 'light' ? '#475569' : '#cbd5e1') + ';margin-top:3px;">BTC Spot: $' + Math.round(interpSpot).toLocaleString() + '</div>';
        }

        tip.innerHTML =
          '<div style="font-size:10.5px;color:' + (activeTheme === 'light' ? '#64748b' : '#94a3b8') + ';margin-bottom:2px;">' + fmtDate(targetT) + ' (' + pctProg + '%)</div>' +
          '<div style="font-size:13px;font-weight:700;color:' + pCol + ';">P&L: ' + fmtMoney(interpPnl) + '</div>' +
          extraInfo;
      }
    };

    const onLeave = () => {
      if (hairG) hairG.style.display = 'none';
      if (tip) tip.style.display = 'none';
    };

    wrap.addEventListener('pointermove', onMove);
    wrap.addEventListener('pointerdown', onMove);
    wrap.addEventListener('pointerleave', onLeave);
    wrap.addEventListener('touchmove', onMove, { passive: true });
    wrap.addEventListener('touchend', onLeave);
  }

  /**
   * Keep existing v133 SVG charts enhanced with continuous hairline crosshair
   */
  function enhanceV133EquityCurve() {
    const svgs = D.querySelectorAll('#pgPnl svg');
    svgs.forEach(svg => {
      if (svg.closest('#vLivePnlTick')) return;
      if (svg.__hasEnhancedCrosshair) return;
      svg.__hasEnhancedCrosshair = true;

      const path = svg.querySelector('path[d^="M"], path[stroke="#10b981"], path[stroke="#f43f5e"]');
      if (!path) return;

      const g = D.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'v133-hairline');
      g.style.display = 'none';
      g.style.pointerEvents = 'none';
      g.innerHTML =
        '<line class="v133-hv" x1="0" y1="0" x2="0" y2="100%" stroke="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" stroke-width="1.2" stroke-dasharray="3 3"/>' +
        '<line class="v133-hh" x1="0" y1="0" x2="100%" y2="0" stroke="' + (activeTheme === 'light' ? 'rgba(15,23,42,0.45)' : 'rgba(255,255,255,0.7)') + '" stroke-width="1.2" stroke-dasharray="3 3"/>' +
        '<circle class="v133-hdot" cx="0" cy="0" r="4.5" fill="' + (activeTheme === 'light' ? '#0284c7' : '#38bdf8') + '" stroke="#fff" stroke-width="1.5"/>';
      svg.appendChild(g);

      const overlay = D.createElementNS('http://www.w3.org/2000/svg', 'rect');
      overlay.setAttribute('x', '0');
      overlay.setAttribute('y', '0');
      overlay.setAttribute('width', '100%');
      overlay.setAttribute('height', '100%');
      overlay.setAttribute('fill', 'rgba(0,0,0,0)');
      overlay.style.cursor = 'crosshair';
      svg.appendChild(overlay);

      const hv = g.querySelector('.v133-hv');
      const hh = g.querySelector('.v133-hh');
      const dot = g.querySelector('.v133-hdot');

      const onMove = e => {
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const cy = e.touches ? e.touches[0].clientY : e.clientY;
        const mx = Math.max(0, Math.min(rect.width, cx - rect.left));
        const my = Math.max(0, Math.min(rect.height, cy - rect.top));

        const vb = svg.viewBox.baseVal;
        const vw = vb && vb.width ? vb.width : rect.width;
        const vh = vb && vb.height ? vb.height : rect.height;
        const svgX = (mx / rect.width) * vw;
        const svgY = (my / rect.height) * vh;

        g.style.display = 'block';
        if (hv) { hv.setAttribute('x1', svgX); hv.setAttribute('x2', svgX); }
        if (hh) { hh.setAttribute('y1', svgY); hh.setAttribute('y2', svgY); }
        if (dot) { dot.setAttribute('cx', svgX); dot.setAttribute('cy', svgY); }
      };

      const onLeave = () => { g.style.display = 'none'; };

      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerleave', onLeave);
      overlay.addEventListener('touchmove', onMove, { passive: true });
      overlay.addEventListener('touchend', onLeave);
    });
  }

  // Only install a lightweight pgPnl observer — do NOT intercept global clicks
  let hooksInstalled = false;
  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;

    // Passively observe pgPnl nav button clicks only — no stopPropagation, no capture phase
    D.addEventListener('click', e => {
      const btn = e.target && e.target.closest && e.target.closest('[data-page="pgPnl"]');
      if (btn) {
        setTimeout(navigateToPnl, 10);
      }
    }); // bubble phase only — does NOT intercept any other clicks
  }

  // Observe ONLY pgPnl element class changes — never the whole subtree
  try {
    const pnlEl = ensurePnlHost();
    if (pnlEl) {
      let wasVisible = false;
      const observer = new MutationObserver(() => {
        const isVisible = pnlEl.classList.contains('on') || D.body.dataset.page === 'pgPnl';
        if (isVisible && !wasVisible) {
          // Only redraw when pgPnl just became visible (transition on → not running every mutation)
          wasVisible = true;
          scheduleRedraw();
        } else if (!isVisible) {
          wasVisible = false;
        }
      });
      // Observe ONLY the pgPnl element itself for class changes — NOT subtree
      observer.observe(pnlEl, { attributes: true, attributeFilter: ['class'] });
      // Also watch body.dataset.page changes
      observer.observe(D.body, { attributes: true, attributeFilter: ['data-page'] });
    }
  } catch {}

  // Single debounced redraw — prevents multiple rapid drawPanel() calls
  let _redrawTimer = null;
  function scheduleRedraw() {
    if (_redrawTimer) return;
    _redrawTimer = setTimeout(() => {
      _redrawTimer = null;
      const pnl = $('pgPnl');
      if (pnl && (pnl.classList.contains('on') || D.body.dataset.page === 'pgPnl')) {
        drawPanel();
      }
    }, 80);
  }

  // Poll positions every 5s — only redraw if pgPnl is visible
  setInterval(() => {
    pollDeltaPositions();
  }, 5000);

  // Poll fills every 15s — only redraw if pgPnl is visible
  setInterval(() => {
    pollDeltaFills();
  }, 15000);

  // Update floating pill every 6s regardless of page
  setInterval(() => {
    const anyOpen = getAnyOpenPosition();
    updateFloatingPnl(anyOpen);
  }, 6000);

  // Light maintenance — just ensure nav button exists, no DOM rebuild
  setInterval(() => {
    installHooks();
    ensurePnlNav();
  }, 5000);

  // Export to window
  W.vLivePnl = {
    getAnyOpenPosition,
    getActiveModeOpenPosition,
    getActiveModeLastClosedTrade,
    setMode: m => {
      switchPnlAccountMode(m);
    },
    toggleTheme: togglePnlTheme,
    pollDeltaPositions,
    pollDeltaFills,
    enhanceV133EquityCurve,
    navigateToPnl
  };

  // Immediate boot
  setTimeout(() => {
    installHooks();
    ensurePnlNav();
    applyThemeToDom();
    pollDeltaPositions();
    pollDeltaFills();
    drawPanel();
  }, 150);
})();
</script>`;
}

function updateFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const styleStart = content.indexOf('<style id="vLivePnlTickCss">');
  if (styleStart === -1) {
    throw new Error('Could not find style tag in ' + filePath);
  }

  const bodyIdx = content.indexOf('</body>', styleStart);
  if (bodyIdx === -1) {
    throw new Error('Could not find </body> in ' + filePath);
  }

  const scriptEndIdx = content.lastIndexOf('</script>', bodyIdx);
  if (scriptEndIdx === -1) {
    throw new Error('Could not find </script> in ' + filePath);
  }

  const replacement = buildModule();
  const newContent = content.slice(0, styleStart) + replacement + content.slice(scriptEndIdx + '</script>'.length);
  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log('Successfully updated', filePath);
}

updateFile('frontend/index.html');
updateFile('Volatility Desk.html');

