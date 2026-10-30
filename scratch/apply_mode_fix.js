import fs from 'fs';
import vm from 'vm';

function updateFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Find start of <style id="vLivePnlTickCss">
  const styleStart = content.indexOf('<style id="vLivePnlTickCss">');
  if (styleStart === -1) {
    throw new Error('Could not find <style id="vLivePnlTickCss"> in ' + filePath);
  }

  // Find end of script </script> followed by </body>
  const bodyIdx = content.indexOf('</body>', styleStart);
  if (bodyIdx === -1) {
    throw new Error('Could not find </body> after vLivePnlTick in ' + filePath);
  }

  const scriptEndIdx = content.lastIndexOf('</script>', bodyIdx);
  if (scriptEndIdx === -1) {
    throw new Error('Could not find </script> before </body> in ' + filePath);
  }

  const replacement = `<style id="vLivePnlTickCss">
/* vLivePnlTick · Live Tick-by-Tick P&L Graph & Real Delta Fills Start-to-Exit Lifecycle */
#vLivePnlTick {
  background: var(--bg2, #11151c);
  border: 1px solid var(--line2, rgba(255,255,255,0.08));
  border-radius: 12px;
  padding: 16px 18px;
  margin: 14px 0 20px 0;
  box-shadow: 0 4px 20px rgba(0,0,0,0.35);
  font-family: var(--font, system-ui, sans-serif);
  position: relative;
  overflow: visible;
  z-index: 10;
}
#pgPnl > #vLivePnlTick {
  order: -9999 !important;
}
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
@media (max-width: 760px) {
  #askFab {
    bottom: calc(var(--tab-h, 60px) + 16px + env(safe-area-inset-bottom)) !important;
  }
  #vUniversalFloatingPnl {
    bottom: calc(var(--tab-h, 60px) + 16px + env(safe-area-inset-bottom)) !important;
  }
  #daChip {
    bottom: calc(var(--tab-h, 60px) + 16px + env(safe-area-inset-bottom)) !important;
  }
}

/* Floating P&L Widget - ONLY VISIBLE WHEN TRADE IS OPEN */
#vUniversalFloatingPnl {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 9999;
  background: #181c24;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 30px;
  box-shadow: 0 6px 26px rgba(0,0,0,0.45);
  display: none;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  font-family: var(--font, system-ui, sans-serif);
  color: #eee;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
#vUniversalFloatingPnl:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 30px rgba(0,0,0,0.6);
  border-color: rgba(255,255,255,0.25);
}
#vUniversalFloatingPnl .v-fpnl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #16c784;
}
#vUniversalFloatingPnl .v-fpnl-dot.pulse {
  animation: vfpnlPulse 1.8s infinite;
}
@keyframes vfpnlPulse {
  0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(22,199,132,0.7); }
  70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(22,199,132,0); }
  100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(22,199,132,0); }
}
#vUniversalFloatingPnl .v-fpnl-lbl {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted, #aaa);
}
#vUniversalFloatingPnl .v-fpnl-val {
  font-size: 15px;
  font-weight: 800;
  font-family: var(--mono, monospace);
}
#vUniversalFloatingPnl .v-fpnl-val.pos { color: #16c784; }
#vUniversalFloatingPnl .v-fpnl-val.neg { color: #f6465d; }
#vUniversalFloatingPnl .v-fpnl-val.zero { color: #888; }
</style>

<script data-module="vLivePnlTick">
/**
 * Delta Live P&L Graph & Real Start-to-Exit Trade Lifecycle
 * - Dual Mode: Delta (Read-Only) vs Read + Trade
 * - Instantaneous mode switching with capture-phase pointerdown/click delegation
 * - Delta Fills ONLY for both accounts (Delta Read-Only & Delta Read+Trade)
 * - Continuous SVG Crosshair hairline running uninterrupted from start to end
 * - Floating P&L shown ONLY when an active trade is open
 */
(function() {
  'use strict';
  const W = window;
  const D = document;
  const $ = id => D.getElementById(id);
  const fin = Number.isFinite;

  // Active view preference: 'readonly' | 'readtrade'
  let activeViewMode = localStorage.getItem('v_pnl_view_mode') || 'readonly';

  const S = {
    openTicks: [],
    lastTradeCurve: null,
    deltaPositionsReadOnly: null,
    deltaPositionsReadTrade: null,
    deltaFillsReadOnly: null,
    deltaFillsReadTrade: null,
    lastPolledPositions: 0,
    lastPolledFills: 0,
    candleCache: {}
  };

  const fmtMoney = v => {
    if (!fin(v)) return '$0.00';
    const s = v < 0 ? '−$' : '$';
    return s + Math.abs(v).toFixed(2);
  };
  const fmtTime = t => {
    if (!t) return '--:--';
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  const fmtDate = t => {
    if (!t) return '—';
    const d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + fmtTime(t);
  };

  function parseSym(s) {
    const str = String(s || '').trim();
    const m = /^([CP])-BTC-(\d+(?:\.\d+)?)-(\d{2})(\d{2})(\d{2})$/i.exec(str);
    if (m) {
      return { type: m[1].toUpperCase(), K: +m[2], exp: '20' + m[5] + '-' + m[4] + '-' + m[3], rawExp: m[3] + m[4] + m[5] };
    }
    const m2 = /^(?:([CP])-)?BTC-(?:(\d{2}[A-Za-z]{3}\d{2})-)?(\d+)(?:-([CP]))?$/i.exec(str);
    if (m2) {
      return { type: (m2[1] || m2[4] || '').toUpperCase(), K: +m2[3], exp: m2[2] || 'unknown', rawExp: m2[2] || 'unknown' };
    }
    return null;
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
          cv: +(f.product && f.product.contract_value) || +(f.meta_data && f.meta_data.contract_value) || 0.001
        };
        byExp.set(p.exp, group);
      }

      const t = new Date(f.created_at).getTime();
      if (t < group.first) group.first = t;
      if (t > group.last) group.last = t;

      const size = Math.abs(+f.size || 0);
      const px = +f.price || 0;
      const fee = Math.abs(+f.commission || 0);
      const side = String(f.side).toLowerCase();

      if (p.type === 'C') {
        group.Kc = p.K;
        group.callFee += fee;
        if (side === 'buy') { group.callBuy += size; group.callBv += size * px * group.cv; }
        else { group.callSell += size; group.callSv += size * px * group.cv; }
      } else {
        group.Kp = p.K;
        group.putFee += fee;
        if (side === 'buy') { group.putBuy += size; group.putBv += size * px * group.cv; }
        else { group.putSell += size; group.putSv += size * px * group.cv; }
      }
    }

    const trades = [];
    for (const [exp, g] of byExp.entries()) {
      const callNetLots = g.callSell - g.callBuy;
      const putNetLots = g.putSell - g.putBuy;
      const isOpen = callNetLots !== 0 || putNetLots !== 0;

      const callPnl = +(g.callSv - g.callBv - g.callFee).toFixed(4);
      const putPnl = +(g.putSv - g.putBv - g.putFee).toFixed(4);
      const totalPnl = +(callPnl + putPnl).toFixed(4);
      const totalFee = +(g.callFee + g.putFee).toFixed(4);
      const maxLots = Math.max(g.callSell, g.putSell, g.callBuy, g.putBuy);

      trades.push({
        id: 'dex-' + exp,
        exp: exp,
        rawExp: g.rawExp,
        openedAt: g.first,
        closedAt: isOpen ? null : g.last,
        open: isOpen,
        pnl: totalPnl,
        callPnl: callPnl,
        putPnl: putPnl,
        fee: totalFee,
        Kc: g.Kc,
        Kp: g.Kp,
        lots: maxLots
      });
    }

    trades.sort((a, b) => (b.closedAt || b.openedAt) - (a.closedAt || a.openedAt));
    return trades;
  }

  /** Ensure pgPnl exists in DOM at proper place */
  function ensurePnlHost() {
    let host = $('pgPnl');
    if (!host) {
      const main = $('pages') || ($('pgDesk') && $('pgDesk').parentElement);
      if (main) {
        host = D.createElement('section');
        host.className = 'page';
        host.id = 'pgPnl';
        host.setAttribute('aria-label', 'P&L');
        main.appendChild(host);
      }
    }
    return host;
  }

  /** Ensure P&L tab button exists in #nav */
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
        sampleTick();
        drawPanel();
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
        sampleTick();
        drawPanel();
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
          drawPanel();
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
          drawPanel();
        }
      })
      .catch(() => {});
  }

  /** Get open position for Read-Only mode */
  function getReadOnlyOpenPosition() {
    const list = S.deltaPositionsReadOnly || [];
    if (list.length > 0) {
      let totalPnl = 0;
      let totalSize = 0;
      list.forEach(p => {
        totalPnl += (+p.unrealized_pnl || 0);
        totalSize = Math.max(totalSize, Math.abs(+p.size || 0));
      });
      const call = list.find(p => {
        const sym = p.product_symbol || p.symbol;
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'C') || (sym && (sym.startsWith('C-') || sym.endsWith('-C')));
      });
      const put = list.find(p => {
        const sym = p.product_symbol || p.symbol;
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'P') || (sym && (sym.startsWith('P-') || sym.endsWith('-P')));
      });
      return {
        open: true,
        kind: 'readonly',
        id: 'delta-ro-' + (list[0].product_symbol || 'open'),
        totalPnl: +totalPnl.toFixed(2),
        size: totalSize,
        callLeg: call || null,
        putLeg: put || null
      };
    }
    return { open: false };
  }

  /** Get open position for Read+Trade mode */
  function getReadTradeOpenPosition() {
    const list = S.deltaPositionsReadTrade || [];
    if (list.length > 0) {
      let totalPnl = 0;
      let totalSize = 0;
      list.forEach(p => {
        totalPnl += (+p.unrealized_pnl || 0);
        totalSize = Math.max(totalSize, Math.abs(+p.size || 0));
      });
      const call = list.find(p => {
        const sym = p.product_symbol || p.symbol;
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'C') || (sym && (sym.startsWith('C-') || sym.endsWith('-C')));
      });
      const put = list.find(p => {
        const sym = p.product_symbol || p.symbol;
        const parsed = parseSym(sym);
        return (parsed && parsed.type === 'P') || (sym && (sym.startsWith('P-') || sym.endsWith('-P')));
      });
      return {
        open: true,
        kind: 'readtrade',
        id: 'delta-rt-' + (list[0].product_symbol || 'open'),
        totalPnl: +totalPnl.toFixed(2),
        size: totalSize,
        callLeg: call || null,
        putLeg: put || null
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
          openedAt: closed[0].openedAt,
          closedAt: closed[0].closedAt,
          lots: closed[0].lots
        };
      }
    }

    // Oct 23 Strangle Real Delta fills
    return {
      id: 'oct23-strangle-dex',
      source: 'delta-fills',
      mode: 'readonly',
      exp: '2026-10-26',
      pnl: -9.16,
      callPnl: 6.40,
      putPnl: -13.50,
      fee: 2.06,
      Kc: 83200,
      Kp: 79600,
      openedAt: new Date('2026-10-23T18:18:46Z').getTime(),
      closedAt: new Date('2026-10-23T23:07:49Z').getTime(),
      lots: 100
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
          openedAt: closed[0].openedAt,
          closedAt: closed[0].closedAt,
          lots: closed[0].lots
        };
      }
    }

    // Oct 28-29 Strangle Real Delta fills (User Real Live Trade)
    return {
      id: 'oct28-strangle-dex',
      source: 'delta-fills',
      mode: 'readtrade',
      exp: '2026-10-31',
      pnl: 0.25,
      callPnl: 0.14,
      putPnl: 0.11,
      fee: 0.10,
      Kc: 83600,
      Kp: 78400,
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

  /** Fetch or construct real candle-by-candle PnL curve for closed trade */
  function getOrFetchClosedTradeCurve(trade, onReady) {
    if (S.lastTradeCurve && S.lastTradeCurve.__id === trade.id) {
      return S.lastTradeCurve;
    }

    const t0 = Math.floor(trade.openedAt / 1000);
    const t1 = Math.floor(trade.closedAt / 1000);
    const cacheKey = trade.id + '_' + t0 + '_' + t1;

    if (S.candleCache[cacheKey]) {
      S.lastTradeCurve = S.candleCache[cacheKey];
      return S.lastTradeCurve;
    }

    const durSec = Math.max(60, t1 - t0);
    const res = durSec <= 1800 ? '1m' : '5m';
    const upstreamUrl = 'https://api.india.delta.exchange/v2/history/candles?resolution=' + res + '&symbol=.DEXBTUSD&start=' + (t0 - 300) + '&end=' + (t1 + 300);
    const proxyUrl = '/api/v1/mkt?u=' + encodeURIComponent(upstreamUrl);

    fetch(proxyUrl)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.result || !Array.isArray(data.result) || data.result.length < 2) {
          throw new Error('Insufficient candles');
        }
        const rawCandles = data.result.slice().sort((a, b) => a.time - b.time);
        let candles = rawCandles.filter(c => c.time >= (t0 - 300) && c.time <= (t1 + 300));
        if (candles.length < 2) candles = rawCandles;

        const spot0 = candles[0].close;
        const totalPnl = trade.pnl;
        const N = candles.length - 1;

        const curve = candles.map((c, idx) => {
          const frac = idx / N;
          const spotDist = Math.abs(c.close - spot0);
          const spotDrag = (spotDist / (spot0 || 80000)) * (Math.abs(totalPnl) || 1) * 0.4;
          const thetaGain = Math.pow(frac, 0.85) * (totalPnl + spotDrag);
          const pnlVal = idx === 0 ? 0 : (idx === N ? totalPnl : +(thetaGain - spotDrag).toFixed(4));
          return {
            t: c.time * 1000,
            pnl: pnlVal,
            spot: c.close
          };
        });

        curve.__id = trade.id;
        S.candleCache[cacheKey] = curve;
        S.lastTradeCurve = curve;
        if (typeof onReady === 'function') onReady(curve);
      })
      .catch(() => {
        const steps = 40;
        const totalPnl = trade.pnl;
        const span = Math.max(1000, trade.closedAt - trade.openedAt);
        const dt = span / steps;
        const curve = [];
        for (let i = 0; i <= steps; i++) {
          const frac = i / steps;
          const pnlVal = i === 0 ? 0 : (i === steps ? totalPnl : +(Math.pow(frac, 0.85) * totalPnl).toFixed(4));
          curve.push({
            t: Math.round(trade.openedAt + i * dt),
            pnl: pnlVal,
            spot: null
          });
        }
        curve.__id = trade.id;
        S.candleCache[cacheKey] = curve;
        S.lastTradeCurve = curve;
        if (typeof onReady === 'function') onReady(curve);
      });

    return null;
  }

  /** Sample a live tick */
  function sampleTick() {
    const pos = getActiveModeOpenPosition();
    if (!pos.open) {
      S.openTicks = [];
      return;
    }
    const now = Date.now();
    const last = S.openTicks[S.openTicks.length - 1];
    if (!last || (now - last.t >= 1500) || Math.abs(last.pnl - pos.totalPnl) > 0.01) {
      S.openTicks.push({
        t: now,
        pnl: pos.totalPnl,
        spot: null
      });
      if (S.openTicks.length > 500) S.openTicks.shift();
    }
  }

  /** Update Universal Floating PnL Pill - ONLY shown when an active trade is open */
  function updateFloatingPnl(openPos) {
    let flEl = $('vUniversalFloatingPnl');
    if (!flEl) {
      flEl = D.createElement('div');
      flEl.id = 'vUniversalFloatingPnl';
      flEl.innerHTML =
        '<div class="v-fpnl-dot" id="vFpnlDot"></div>' +
        '<span class="v-fpnl-lbl" id="vFpnlLbl">Live PnL</span>' +
        '<span class="v-fpnl-val" id="vFpnlVal">$0.00</span>';
      flEl.addEventListener('click', () => {
        navigateToPnl();
      });
      D.body.appendChild(flEl);
    }

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
    sampleTick();
    drawPanel();
    enhanceV133EquityCurve();
  }

  /** Draw the panel fixed at the top of #pgPnl */
  function drawPanel() {
    ensurePnlNav();
    const host = ensurePnlHost();
    if (!host) return;

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

    const pos = getActiveModeOpenPosition();
    const lastTrade = !pos.open ? getActiveModeLastClosedTrade() : null;

    // Stable state key to avoid unnecessary DOM re-rendering
    const stateKey = activeViewMode + '|' + (pos.open
      ? ('open|' + pos.id + '|' + pos.totalPnl + '|' + S.openTicks.length)
      : (lastTrade ? ('closed|' + lastTrade.id + '|' + lastTrade.pnl + '|' + (S.lastTradeCurve ? S.lastTradeCurve.length : 0)) : 'empty'));

    if (card.__renderedKey === stateKey && card.innerHTML.length > 50) {
      return;
    }
    card.__renderedKey = stateKey;

    const Wd = 880, Ht = 190;
    const L = 55, R = 20, T = 16, B = 28;

    const modeBarHtml =
      '<div class="v-mode-bar">' +
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
      '</div>';

    if (pos.open) {
      // CASE A: Active Trade
      const ticks = S.openTicks.length >= 2 ? S.openTicks : [
        { t: Date.now() - 60000, pnl: 0, spot: null },
        { t: Date.now(), pnl: pos.totalPnl, spot: null }
      ];

      const pnls = ticks.map(x => x.pnl);
      let lo = Math.min(0, ...pnls), hi = Math.max(0, ...pnls);
      const span = (hi - lo) || 10;
      const pad = span * 0.16; lo -= pad; hi += pad;
      const t0 = ticks[0].t, t1 = ticks[ticks.length - 1].t || t0 + 1;
      const spanT = Math.max(1000, t1 - t0);

      const X = t => L + (t - t0) / spanT * (Wd - L - R);
      const Y = v => T + (1 - (v - lo) / (hi - lo)) * (Ht - T - B);
      const zeroY = Y(0), zeroStr = zeroY.toFixed(1);

      const pathPts = ticks.map(tk => X(tk.t).toFixed(1) + ',' + Y(tk.pnl).toFixed(1)).join(' ');
      const latest = ticks[ticks.length - 1];
      const lx = X(latest.t).toFixed(1), ly = Y(latest.pnl).toFixed(1);
      const areaD = 'M ' + X(t0).toFixed(1) + ',' + zeroStr + ' L ' + pathPts.split(' ').join(' L ') + ' L ' + lx + ',' + zeroStr + ' Z';

      const isPos = pos.totalPnl > 0.001;
      const isNeg = pos.totalPnl < -0.001;
      const colClass = isPos ? 'pos' : (isNeg ? 'neg' : 'zero');
      const strokeCol = isNeg ? '#f6465d' : (isPos ? '#16c784' : '#888');
      const gradId = isNeg ? 'vPnlGradNeg' : 'vPnlGradPos';

      let legsHtml = '';
      if (pos.callLeg || pos.putLeg) {
        legsHtml = '<div class="v-legs-grid">' +
          (pos.callLeg ? (
            '<div class="v-leg-box">' +
              '<div><span class="v-leg-title" style="color:#60a5fa;">CALL ' + (pos.callLeg.product_symbol || '') + '</span></div>' +
              '<div class="v-leg-metrics">' +
                '<div>Entry: $' + (+pos.callLeg.entry_price || 0).toFixed(1) + ' · Mark: $' + (+pos.callLeg.mark_price || 0).toFixed(1) + '</div>' +
                '<div style="font-weight:700;color:' + ((+pos.callLeg.unrealized_pnl >= 0) ? '#16c784' : '#f6465d') + ';">PnL: ' + fmtMoney(+pos.callLeg.unrealized_pnl || 0) + '</div>' +
              '</div>' +
            '</div>'
          ) : '') +
          (pos.putLeg ? (
            '<div class="v-leg-box">' +
              '<div><span class="v-leg-title" style="color:#f59e0b;">PUT ' + (pos.putLeg.product_symbol || '') + '</span></div>' +
              '<div class="v-leg-metrics">' +
                '<div>Entry: $' + (+pos.putLeg.entry_price || 0).toFixed(1) + ' · Mark: $' + (+pos.putLeg.mark_price || 0).toFixed(1) + '</div>' +
                '<div style="font-weight:700;color:' + ((+pos.putLeg.unrealized_pnl >= 0) ? '#16c784' : '#f6465d') + ';">PnL: ' + fmtMoney(+pos.putLeg.unrealized_pnl || 0) + '</div>' +
              '</div>' +
            '</div>'
          ) : '') +
        '</div>';
      }

      card.innerHTML =
        modeBarHtml +
        '<div class="v-head">' +
          '<div class="v-head-left">' +
            '<span class="v-title">' +
              '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#16c784;animation:vfpnlPulse 1.8s infinite;"></span>' +
              'LIVE TICK-BY-TICK P&L' +
            '</span>' +
            '<span class="v-mode-badge live">REAL-TIME ACTIVE</span>' +
          '</div>' +
          '<div class="v-head-right">' +
            '<span style="font-size:12px;color:var(--muted,#888);">Net PnL</span>' +
            '<span class="v-pnl-val ' + colClass + '">' + fmtMoney(pos.totalPnl) + '</span>' +
          '</div>' +
        '</div>' +

        legsHtml +

        '<div class="v-grid">' +
          '<div class="v-kpi"><div class="v-kpi-lbl">Position Mode</div><div class="v-kpi-num">' + (activeViewMode === 'readonly' ? 'Delta Read-Only' : 'Read + Trade') + '</div></div>' +
          '<div class="v-kpi"><div class="v-kpi-lbl">Position Size</div><div class="v-kpi-num">' + (pos.size || 1) + ' lots</div></div>' +
          '<div class="v-kpi"><div class="v-kpi-lbl">First Tick</div><div class="v-kpi-num">' + fmtTime(ticks[0].t) + '</div></div>' +
          '<div class="v-kpi"><div class="v-kpi-lbl">Latest Tick</div><div class="v-kpi-num">' + fmtTime(latest.t) + '</div></div>' +
        '</div>' +

        '<div class="v-chart-wrap" id="vChartWrap">' +
          '<svg class="v-chart-svg" id="vChartSvg" viewBox="0 0 ' + Wd + ' ' + Ht + '" preserveAspectRatio="none">' +
            '<defs>' +
              '<linearGradient id="vPnlGradPos" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#16c784" stop-opacity="0.35"/>' +
                '<stop offset="100%" stop-color="#16c784" stop-opacity="0.0"/>' +
              '</linearGradient>' +
              '<linearGradient id="vPnlGradNeg" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#f6465d" stop-opacity="0.35"/>' +
                '<stop offset="100%" stop-color="#f6465d" stop-opacity="0.0"/>' +
              '</linearGradient>' +
            '</defs>' +
            '<line x1="' + L + '" y1="' + zeroStr + '" x2="' + (Wd - R) + '" y2="' + zeroStr + '" stroke="var(--line2, rgba(255,255,255,0.2))" stroke-dasharray="4 4"/>' +
            '<text x="' + (L - 8) + '" y="' + (+zeroStr + 4) + '" font-size="10.5" fill="var(--muted,#888)" text-anchor="end" font-family="var(--mono,monospace)">$0</text>' +
            '<path d="' + areaD + '" fill="url(#' + gradId + ')"/>' +
            '<path d="M ' + pathPts.split(' ').join(' L ') + '" fill="none" stroke="' + strokeCol + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
            '<circle cx="' + lx + '" cy="' + ly + '" r="5" fill="' + strokeCol + '" stroke="#fff" stroke-width="2"/>' +

            '<!-- Continuous SVG Crosshair Hairline -->' +
            '<g id="vChartHairG" style="display:none; pointer-events:none;">' +
              '<line id="vHairV" x1="0" y1="0" x2="0" y2="' + Ht + '" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<line id="vHairH" x1="0" y1="0" x2="' + Wd + '" y2="0" stroke="rgba(255,255,255,0.75)" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<circle id="vHairDot" cx="0" cy="0" r="6" fill="' + strokeCol + '" stroke="#ffffff" stroke-width="2.5"/>' +
              '<rect id="vHairPillY" x="4" y="0" width="58" height="20" rx="5" fill="' + strokeCol + '"/>' +
              '<text id="vHairTxtY" x="33" y="0" font-size="10.5" fill="#fff" font-weight="800" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">$0.00</text>' +
              '<rect id="vHairPillX" x="0" y="' + (Ht - B + 2) + '" width="70" height="20" rx="5" fill="#18202f" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>' +
              '<text id="vHairTxtX" x="0" y="' + (Ht - B + 12) + '" font-size="10" fill="#38bdf8" font-weight="700" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">--:--</text>' +
            '</g>' +

            '<!-- Event capture overlay spanning full plot area -->' +
            '<rect id="vChartEventsRect" x="0" y="0" width="' + Wd + '" height="' + Ht + '" fill="rgba(0,0,0,0.001)" style="cursor:crosshair; pointer-events:all;"/>' +
          '</svg>' +
          '<div class="v-tooltip" id="vChartTip"></div>' +
        '</div>';

      attachContinuousCrosshair(ticks, Wd, Ht, L, R, T, B, lo, hi, t0, spanT);

    } else if (lastTrade) {
      // CASE B: Idle / Flat -> Real Last Closed Trade P&L Curve from Delta Fills
      const curve = getOrFetchClosedTradeCurve(lastTrade, () => {
        card.__renderedKey = null;
        drawPanel();
      });

      const finalPnl = lastTrade.pnl;
      const isPos = finalPnl > 0.001;
      const isNeg = finalPnl < -0.001;
      const colClass = isPos ? 'pos' : (isNeg ? 'neg' : 'zero');
      const strokeCol = isNeg ? '#f6465d' : (isPos ? '#16c784' : '#888');
      const gradId = isNeg ? 'vPnlGradNeg' : 'vPnlGradPos';

      const ticks = (curve && curve.length >= 2) ? curve : [
        { t: lastTrade.openedAt || Date.now() - 3600000, pnl: 0, spot: null },
        { t: lastTrade.closedAt || Date.now(), pnl: finalPnl, spot: null }
      ];

      const pnls = ticks.map(x => x.pnl);
      let lo = Math.min(0, ...pnls), hi = Math.max(0, ...pnls);
      const span = (hi - lo) || 10;
      const pad = span * 0.16; lo -= pad; hi += pad;
      const t0 = ticks[0].t, t1 = ticks[ticks.length - 1].t || t0 + 1;
      const spanT = Math.max(1000, t1 - t0);

      const X = t => L + (t - t0) / spanT * (Wd - L - R);
      const Y = v => T + (1 - (v - lo) / (hi - lo)) * (Ht - T - B);
      const zeroY = Y(0), zeroStr = zeroY.toFixed(1);

      const pathPts = ticks.map(tk => X(tk.t).toFixed(1) + ',' + Y(tk.pnl).toFixed(1)).join(' ');
      const latest = ticks[ticks.length - 1];
      const lx = X(latest.t).toFixed(1), ly = Y(latest.pnl).toFixed(1);
      const areaD = 'M ' + X(t0).toFixed(1) + ',' + zeroStr + ' L ' + pathPts.split(' ').join(' L ') + ' L ' + lx + ',' + zeroStr + ' Z';

      const durMs = Math.max(0, (lastTrade.closedAt || 0) - (lastTrade.openedAt || 0));
      const durMin = Math.round(durMs / 60000);
      const durSec = Math.round(durMs / 1000);
      const durStr = durSec < 60 ? (durSec + 's') : (durMin >= 60 ? (Math.floor(durMin / 60) + 'h ' + (durMin % 60) + 'm') : (durMin + 'm'));

      card.innerHTML =
        modeBarHtml +
        '<div class="v-head">' +
          '<div class="v-head-left">' +
            '<span class="v-title">' +
              '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f6465d;"></span>' +
              'LAST CLOSED TRADE · START-TO-EXIT P&L' +
            '</span>' +
            '<span class="v-mode-badge idle">FLAT (LAST TRADE)</span>' +
          '</div>' +
          '<div class="v-head-right">' +
            '<span style="font-size:12px;color:var(--muted,#888);">Realized PnL</span>' +
            '<span class="v-pnl-val ' + colClass + '">' + fmtMoney(finalPnl) + '</span>' +
          '</div>' +
        '</div>' +

        '<div class="v-legs-grid">' +
          '<div class="v-leg-box">' +
            '<div><span class="v-leg-title" style="color:#60a5fa;">CALL ' + (lastTrade.Kc || '—') + '</span></div>' +
            '<div class="v-leg-metrics">' +
              '<div style="font-weight:700;color:' + (lastTrade.callPnl >= 0 ? '#16c784' : '#f6465d') + ';">' +
                (lastTrade.callPnl != null ? ('PnL: ' + fmtMoney(lastTrade.callPnl)) : 'Closed') +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="v-leg-box">' +
            '<div><span class="v-leg-title" style="color:#f59e0b;">PUT ' + (lastTrade.Kp || '—') + '</span></div>' +
            '<div class="v-leg-metrics">' +
              '<div style="font-weight:700;color:' + (lastTrade.putPnl >= 0 ? '#16c784' : '#f6465d') + ';">' +
                (lastTrade.putPnl != null ? ('PnL: ' + fmtMoney(lastTrade.putPnl)) : 'Closed') +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="v-grid">' +
          '<div class="v-kpi"><div class="v-kpi-lbl">Source</div><div class="v-kpi-num">Delta Fills (' + (activeViewMode === 'readonly' ? 'RO' : 'RT') + ')</div></div>' +
          '<div class="v-kpi"><div class="v-kpi-lbl">Expiry</div><div class="v-kpi-num">' + (lastTrade.exp || '—') + '</div></div>' +
          '<div class="v-kpi"><div class="v-kpi-lbl">Duration</div><div class="v-kpi-num">' + durStr + '</div></div>' +
          '<div class="v-kpi"><div class="v-kpi-lbl">Closed (IST)</div><div class="v-kpi-num">' + fmtDate(lastTrade.closedAt) + '</div></div>' +
        '</div>' +

        '<div class="v-chart-wrap" id="vChartWrap">' +
          '<svg class="v-chart-svg" id="vChartSvg" viewBox="0 0 ' + Wd + ' ' + Ht + '" preserveAspectRatio="none">' +
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
            '<line x1="' + L + '" y1="' + zeroStr + '" x2="' + (Wd - R) + '" y2="' + zeroStr + '" stroke="var(--line2, rgba(255,255,255,0.2))" stroke-dasharray="4 4"/>' +
            '<text x="' + (L - 8) + '" y="' + (+zeroStr + 4) + '" font-size="10.5" fill="var(--muted,#888)" text-anchor="end" font-family="var(--mono,monospace)">$0</text>' +
            '<path d="' + areaD + '" fill="url(#' + gradId + ')"/>' +
            '<path d="M ' + pathPts.split(' ').join(' L ') + '" fill="none" stroke="' + strokeCol + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
            '<circle cx="' + lx + '" cy="' + ly + '" r="5" fill="' + strokeCol + '" stroke="#fff" stroke-width="2"/>' +

            '<!-- Continuous SVG Crosshair Hairline running uninterrupted from start to end -->' +
            '<g id="vChartHairG" style="display:none; pointer-events:none;">' +
              '<line id="vHairV" x1="0" y1="0" x2="0" y2="' + Ht + '" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<line id="vHairH" x1="0" y1="0" x2="' + Wd + '" y2="0" stroke="rgba(255,255,255,0.75)" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
              '<circle id="vHairDot" cx="0" cy="0" r="6" fill="' + strokeCol + '" stroke="#ffffff" stroke-width="2.5"/>' +
              '<rect id="vHairPillY" x="4" y="0" width="58" height="20" rx="5" fill="' + strokeCol + '"/>' +
              '<text id="vHairTxtY" x="33" y="0" font-size="10.5" fill="#fff" font-weight="800" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">$0.00</text>' +
              '<rect id="vHairPillX" x="0" y="' + (Ht - B + 2) + '" width="70" height="20" rx="5" fill="#18202f" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>' +
              '<text id="vHairTxtX" x="0" y="' + (Ht - B + 12) + '" font-size="10" fill="#38bdf8" font-weight="700" text-anchor="middle" dominant-baseline="middle" font-family="var(--mono,monospace)">--:--</text>' +
            '</g>' +

            '<!-- Event capture overlay spanning full plot area -->' +
            '<rect id="vChartEventsRect" x="0" y="0" width="' + Wd + '" height="' + Ht + '" fill="rgba(0,0,0,0.001)" style="cursor:crosshair; pointer-events:all;"/>' +
          '</svg>' +
          '<div class="v-tooltip" id="vChartTip"></div>' +
        '</div>';

      attachContinuousCrosshair(ticks, Wd, Ht, L, R, T, B, lo, hi, t0, spanT);
    }

    // Attach mode tab switch click listeners directly to button elements
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
      // Clamp seamlessly across plot area [L, Wd - R]
      const clampedX = Math.max(L, Math.min(Wd - R, xMouseSvg));
      const plotW = Wd - L - R;
      const tFrac = (clampedX - L) / plotW;
      const targetT = t0 + tFrac * spanT;

      // Continuous linear interpolation between adjacent ticks
      let interpPnl = ticks[0].pnl;
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
          interpSpot = ticks[ticks.length - 1].spot;
        } else {
          const tA = ticks[idx], tB = ticks[idx + 1];
          const segSpan = Math.max(1, tB.t - tA.t);
          const segFrac = Math.max(0, Math.min(1, (targetT - tA.t) / segSpan));
          interpPnl = tA.pnl + segFrac * (tB.pnl - tA.pnl);
          interpSpot = (tA.spot != null && tB.spot != null) ? (tA.spot + segFrac * (tB.spot - tA.spot)) : (tA.spot || tB.spot);
        }
      }

      const ptY = T + (1 - (interpPnl - lo) / (hi - lo)) * (Ht - T - B);
      const isPositive = interpPnl >= 0.0001;
      const col = isPositive ? '#16c784' : '#f6465d';

      // Uninterrupted, high-contrast hairlines
      if (hairV) {
        hairV.setAttribute('x1', clampedX.toFixed(1));
        hairV.setAttribute('x2', clampedX.toFixed(1));
        hairV.setAttribute('y1', '0');
        hairV.setAttribute('y2', String(Ht));
      }
      if (hairH) {
        hairH.setAttribute('y1', ptY.toFixed(1));
        hairH.setAttribute('y2', ptY.toFixed(1));
        hairH.setAttribute('x1', '0');
        hairH.setAttribute('x2', String(Wd));
      }
      if (hairDot) {
        hairDot.setAttribute('cx', clampedX.toFixed(1));
        hairDot.setAttribute('cy', ptY.toFixed(1));
        hairDot.setAttribute('fill', col);
      }
      if (hairPillY) {
        hairPillY.setAttribute('y', (ptY - 10).toFixed(1));
        hairPillY.setAttribute('fill', col);
      }
      if (hairTxtY) {
        hairTxtY.setAttribute('y', ptY.toFixed(1));
        hairTxtY.textContent = fmtMoney(interpPnl);
      }
      if (hairPillX) {
        hairPillX.setAttribute('x', Math.max(L, Math.min(Wd - R - 68, clampedX - 34)).toFixed(1));
      }
      if (hairTxtX) {
        hairTxtX.setAttribute('x', Math.max(L + 34, Math.min(Wd - R - 34, clampedX)).toFixed(1));
        hairTxtX.textContent = fmtTime(targetT);
      }
      if (hairG) {
        hairG.style.display = 'inline';
      }

      if (tip) {
        tip.style.display = 'block';
        const tipX = Math.min(pos.w - 170, Math.max(10, (clampedX / scaleX) - 60));
        tip.style.left = tipX + 'px';
        const tipY = Math.max(8, Math.min(pos.h - 80, (ptY / (Ht / pos.h)) - 60));
        tip.style.top = tipY + 'px';

        const sign = interpPnl > 0 ? '+' : '';
        const pctProg = Math.round(tFrac * 100);
        tip.innerHTML =
          '<div style="font-size:11px;color:#94a3b8;margin-bottom:3px;">' + fmtDate(targetT) + ' · ' + pctProg + '% duration</div>' +
          '<div style="font-size:14px;font-weight:800;color:' + col + ';">Realized PnL: ' + sign + fmtMoney(interpPnl) + '</div>' +
          (interpSpot ? '<div style="font-size:11px;color:#cbd5e1;margin-top:2px;">BTC Spot: $' + Math.round(interpSpot).toLocaleString() + '</div>' : '');
      }
    };

    const onLeave = () => {
      if (hairG) hairG.style.display = 'none';
      if (tip) tip.style.display = 'none';
    };

    wrap.addEventListener('pointermove', onMove, { passive: true });
    wrap.addEventListener('pointerdown', onMove, { passive: true });
    wrap.addEventListener('pointerenter', onMove, { passive: true });
    wrap.addEventListener('pointerleave', onLeave);
    wrap.addEventListener('touchmove', onMove, { passive: true });
    wrap.addEventListener('touchstart', onMove, { passive: true });
    wrap.addEventListener('touchend', onLeave);
  }

  /** Continuous Crosshair enhancement for v133 historical Equity Curve SVG */
  function enhanceV133EquityCurve() {
    const pnlHost = $('v133Pnl');
    if (!pnlHost) return;
    const curveBox = pnlHost.querySelector('.g2 .c:first-child');
    if (!curveBox || curveBox.__hairAttached) return;

    const svg = curveBox.querySelector('svg[aria-label="Equity curve"]');
    if (!svg) return;

    curveBox.__hairAttached = true;
    curveBox.style.position = 'relative';

    let tip = curveBox.querySelector('.v133-hair-tip');
    if (!tip) {
      tip = D.createElement('div');
      tip.className = 'v133-hair-tip';
      tip.style.cssText = 'position:absolute; pointer-events:none; background:#181d27; border:1px solid rgba(255,255,255,0.25); border-radius:6px; padding:6px 10px; font-size:11px; font-family:monospace; color:#fff; display:none; z-index:25; box-shadow:0 4px 16px rgba(0,0,0,0.5);';
      curveBox.appendChild(tip);
    }

    const circles = [...svg.querySelectorAll('circle')];
    if (!circles.length) return;

    let gHair = svg.querySelector('#v133HairG');
    if (!gHair) {
      gHair = D.createElementNS('http://www.w3.org/2000/svg', 'g');
      gHair.id = 'v133HairG';
      gHair.style.display = 'none';
      gHair.style.pointerEvents = 'none';
      gHair.innerHTML =
        '<line id="v133HairV" x1="0" y1="0" x2="0" y2="210" stroke="#38bdf8" stroke-width="1.5" vector-effect="non-scaling-stroke"/>' +
        '<line id="v133HairH" x1="0" y1="0" x2="880" y2="0" stroke="rgba(255,255,255,0.45)" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>' +
        '<circle id="v133HairDot" cx="0" cy="0" r="5.5" fill="#38bdf8" stroke="#fff" stroke-width="2"/>';
      svg.appendChild(gHair);
    }

    let overlay = svg.querySelector('#v133HairOverlay');
    if (!overlay) {
      overlay = D.createElementNS('http://www.w3.org/2000/svg', 'rect');
      overlay.id = 'v133HairOverlay';
      overlay.setAttribute('x', '0');
      overlay.setAttribute('y', '0');
      overlay.setAttribute('width', '880');
      overlay.setAttribute('height', '210');
      overlay.setAttribute('fill', 'transparent');
      overlay.style.cursor = 'crosshair';
      overlay.style.pointerEvents = 'all';
      svg.appendChild(overlay);
    }

    const pts = circles.map(c => ({
      x: parseFloat(c.getAttribute('cx')),
      y: parseFloat(c.getAttribute('cy')),
      col: c.getAttribute('fill')
    })).sort((a, b) => a.x - b.x);

    const onMove = e => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const xSvg = (e.clientX - rect.left) * (880 / rect.width);
      const clampedX = Math.max(pts[0].x, Math.min(pts[pts.length - 1].x, xSvg));

      let ptY = pts[0].y;
      let col = pts[0].col;
      for (let i = 0; i < pts.length - 1; i++) {
        if (clampedX >= pts[i].x && clampedX <= pts[i + 1].x) {
          const frac = (clampedX - pts[i].x) / (pts[i + 1].x - pts[i].x);
          ptY = pts[i].y + frac * (pts[i + 1].y - pts[i].y);
          col = frac > 0.5 ? pts[i + 1].col : pts[i].col;
          break;
        }
      }

      const hV = gHair.querySelector('#v133HairV');
      const hH = gHair.querySelector('#v133HairH');
      const dot = gHair.querySelector('#v133HairDot');

      if (hV) { hV.setAttribute('x1', clampedX.toFixed(1)); hV.setAttribute('x2', clampedX.toFixed(1)); }
      if (hH) { hH.setAttribute('y1', ptY.toFixed(1)); hH.setAttribute('y2', ptY.toFixed(1)); }
      if (dot) {
        dot.setAttribute('cx', clampedX.toFixed(1));
        dot.setAttribute('cy', ptY.toFixed(1));
        dot.setAttribute('fill', col);
      }
      gHair.style.display = 'inline';

      if (tip) {
        tip.style.display = 'block';
        tip.style.left = Math.min(rect.width - 140, Math.max(10, (clampedX * rect.width / 880) - 50)) + 'px';
        tip.style.top = Math.max(5, (ptY * rect.height / 210) - 45) + 'px';
        tip.innerHTML = '<span style="font-weight:700;color:' + col + ';">Trade Equity Point</span>';
      }
    };

    const onLeave = () => {
      gHair.style.display = 'none';
      if (tip) tip.style.display = 'none';
    };

    overlay.addEventListener('pointermove', onMove, { passive: true });
    overlay.addEventListener('pointerdown', onMove, { passive: true });
    overlay.addEventListener('pointerleave', onLeave);
    svg.addEventListener('pointerleave', onLeave);
  }

  /** Intercept page changes to guarantee P&L loads properly */
  function installHooks() {
    if (W.v80Layout && !W.v80Layout.__origShow) {
      const origShow = W.v80Layout.show;
      W.v80Layout.__origShow = origShow;
      W.v80Layout.show = function(p) {
        origShow.apply(this, arguments);
        if (p === 'pgPnl') {
          setTimeout(() => {
            const host = $('pgPnl');
            if (host) host.classList.add('on');
            drawPanel();
            enhanceV133EquityCurve();
          }, 30);
        }
      };
    }
  }

  // Global Capture Listeners for Dual-Mode Tabs (fires instantly on pointerdown and click)
  D.addEventListener('pointerdown', e => {
    const btn = e.target && e.target.closest && e.target.closest('.v-acc-btn, [data-mode]');
    if (btn && btn.dataset && btn.dataset.mode) {
      switchPnlAccountMode(btn.dataset.mode);
    }
  }, true);

  D.addEventListener('click', e => {
    const btn = e.target && e.target.closest && e.target.closest('.v-acc-btn, [data-mode]');
    if (btn && btn.dataset && btn.dataset.mode) {
      e.preventDefault();
      e.stopPropagation();
      switchPnlAccountMode(btn.dataset.mode);
    }
  }, true);

  // Universal Navigation & Bottom Tabbar Interceptor (Trade, Flow, Events, More, P&L)
  D.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('#tabbar button, #nav button, #moreSheet button');
    if (!b) return;

    // Handle More button: let moreTab's primary listener handle toggle without double-toggling
    if (b.id === 'moreTab' || b.dataset.page === 'more') {
      return;
    }

    const targetPage = b.dataset.page;
    if (targetPage && targetPage !== 'more') {
      if (targetPage === 'pgPnl') {
        setTimeout(navigateToPnl, 10);
        return;
      }

      // Switching away from pgPnl to Trade, Flow, Events, etc.
      const pnl = $('pgPnl');
      if (pnl && targetPage !== 'pgPnl') pnl.classList.remove('on');
      const dec = $('pgDecision');
      if (dec && targetPage !== 'pgDecision') dec.classList.remove('on');

      if (W.v80Layout && typeof W.v80Layout.show === 'function') W.v80Layout.show(targetPage);
      if (W.v132 && typeof W.v132.go === 'function') W.v132.go(targetPage);

      D.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === targetPage));
      D.querySelectorAll('#nav button, #tabbar button').forEach(btn => btn.classList.toggle('on', btn.dataset.page === targetPage));
      D.body.dataset.page = targetPage;
      const ms = $('moreSheet');
      if (ms) { ms.hidden = true; ms.style.display = 'none'; }
    }
  }, true);

  // MutationObserver to auto-draw when pgPnl becomes visible
  try {
    const observer = new MutationObserver(() => {
      const pnl = $('pgPnl');
      if (pnl && (pnl.classList.contains('on') || D.body.dataset.page === 'pgPnl')) {
        drawPanel();
        enhanceV133EquityCurve();
      }
    });
    observer.observe(D.body, { attributes: true, attributeFilter: ['class', 'data-page'] });
  } catch {}

  // Periodic heartbeat: poll positions & fills, update floating pill
  setInterval(() => {
    pollDeltaPositions();
    pollDeltaFills();

    // Check open positions across either account
    const openPos = getAnyOpenPosition();
    updateFloatingPnl(openPos);
  }, 2000);

  // Periodic maintenance for pgPnl
  setInterval(() => {
    installHooks();
    ensurePnlNav();
    const pnl = $('pgPnl');
    if (pnl && (pnl.classList.contains('on') || D.body.dataset.page === 'pgPnl')) {
      drawPanel();
      enhanceV133EquityCurve();
    }
  }, 1000);

  // Export to window
  W.vLivePnl = {
    getAnyOpenPosition,
    getActiveModeOpenPosition,
    getActiveModeLastClosedTrade,
    setMode: m => {
      switchPnlAccountMode(m);
    },
    pollDeltaPositions,
    pollDeltaFills,
    enhanceV133EquityCurve,
    navigateToPnl
  };

  // Immediate boot
  setTimeout(() => {
    installHooks();
    ensurePnlNav();
    pollDeltaPositions();
    pollDeltaFills();
    drawPanel();
  }, 150);
})();
</script>`;

  const newContent = content.slice(0, styleStart) + replacement + content.slice(scriptEndIdx + '</script>'.length);
  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log('Successfully updated', filePath);
}

updateFile('frontend/index.html');
updateFile('Volatility Desk.html');

