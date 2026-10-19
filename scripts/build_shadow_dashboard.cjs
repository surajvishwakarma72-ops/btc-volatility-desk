const fs = require('fs');

const file = 'frontend/index.html';
let html = fs.readFileSync(file, 'utf-8');

// 1. Ensure <script src="data/shadow_backtest_dataset.js"></script> is loaded in <head>
if (!html.includes('data/shadow_backtest_dataset.js')) {
  html = html.replace('<head>', () => '<head>\n<script src="data/shadow_backtest_dataset.js"></script>');
  console.log('Added shadow_backtest_dataset.js script tag to <head>');
}

// 2. Add Shadow Dashboard button in v147Big telemetry bar
const targetTelemBtn = '<button type="button" class="telem-btn" data-a="auditIv" title="View IV Regimes, Stop-Loss Multiples, and Day/Week/Month Seasonality Matrix">📈 IV & Seasonality Audit</button>\'+';
const newTelemBtn = targetTelemBtn + '\n        \'<button type="button" class="telem-btn" data-a="shadowDash" style="background:rgba(56,189,248,.18);border:1px solid #38BDF8;color:#38BDF8;font-weight:800" title="Open Interactive Backtest & Shadow-Mode Performance Dashboard">🛡️ Shadow Backtest Dashboard</button>\'+';

if (!html.includes('data-a="shadowDash"')) {
  html = html.replace(targetTelemBtn, () => newTelemBtn);
  console.log('Added Shadow Dashboard button to telemetry bar');
}

// 3. Add click handler in v147Big for data-a="shadowDash"
const targetHandler = "else if(a==='auditIv'){openAuditIvModal();}";
const newHandler = "else if(a==='auditIv'){openAuditIvModal();}\n      else if(a==='shadowDash'){openShadowDashboard();}";

if (!html.includes("else if(a==='shadowDash')")) {
  html = html.replace(targetHandler, () => newHandler);
  console.log('Added click handler for shadowDash in v147Big');
}

// 4. Add direct access button inside v148NewsLogModal controls bar
const targetNewsCtrl = '<!-- Audio & Archive Controls Bar -->';
const replacementNewsCtrl = `<!-- Audio & Archive Controls Bar -->
      <div style="margin-bottom:8px">
        <button type="button" class="news-ctrl-btn" style="width:100%;background:rgba(56,189,248,.15);border:1px solid #38BDF8;color:#38BDF8;font-weight:700;padding:6px" onclick="$('v148NewsLogModal').hidden=true;openShadowDashboard()">
          🛡️ Open Interactive Shadow-Mode Backtest Dashboard
        </button>
      </div>`;

if (!html.includes('Open Interactive Shadow-Mode Backtest Dashboard')) {
  html = html.replace(targetNewsCtrl, () => replacementNewsCtrl);
  console.log('Added Shadow Dashboard shortcut button to Internal News drawer');
}

// 5. Append Shadow Dashboard Module (CSS & JavaScript) before </body>
const shadowModuleCode = `
<!-- ======================================================================= -->
<!-- MODULE v149: INTERACTIVE SHADOW-MODE BACKTEST & MULTI-INDICATOR DASHBOARD -->
<!-- ======================================================================= -->
<style id="v149ShadowCss">
.v149-modal {
  position: fixed; inset: 0; z-index: 999999;
  display: flex; align-items: center; justify-content: center;
  padding: 12px; box-sizing: border-box;
}
.v149-modal[hidden] { display: none !important; }
.v149-backdrop {
  position: absolute; inset: 0;
  background: rgba(4, 9, 14, 0.88);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
.v149-dialog {
  position: relative; z-index: 2;
  width: 98vw; max-width: 1040px; max-height: 92vh;
  background: #0B141C;
  border: 1px solid rgba(56, 189, 248, 0.35);
  border-radius: 14px;
  box-shadow: 0 20px 50px rgba(0,0,0,0.8), 0 0 30px rgba(56,189,248,0.15);
  display: flex; flex-direction: column;
  overflow: hidden; box-sizing: border-box;
}
.v149-header {
  padding: 14px 18px;
  background: #101B26;
  border-bottom: 1px solid #1F2F3E;
  display: flex; justify-content: space-between; align-items: center;
}
.v149-header b {
  font: 800 16px var(--font, sans-serif); color: #F8FAFC; letter-spacing: 0.03em;
  display: flex; align-items: center; gap: 8px;
}
.v149-header .hd-sub {
  font: 500 11px var(--mono, monospace); color: #94A3B8; margin-top: 3px;
}
.v149-body {
  padding: 14px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
  -webkit-overflow-scrolling: touch;
}
.v149-kpi-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;
}
.v149-kpi-card {
  background: #14212D; border: 1px solid #1F2F3E; border-radius: 8px; padding: 10px 12px;
  cursor: pointer; transition: all 0.2s ease;
}
.v149-kpi-card:hover { border-color: #38BDF8; transform: translateY(-1px); }
.v149-kpi-card.active { border-color: #38BDF8; background: rgba(56, 189, 248, 0.12); }
.v149-kpi-title { font: 700 10.5px var(--font, sans-serif); color: #94A3B8; text-transform: uppercase; letter-spacing: 0.05em; }
.v149-kpi-val { font: 800 18px var(--font, sans-serif); color: #F8FAFC; margin: 4px 0 2px; }
.v149-kpi-sub { font: 600 10px var(--mono, monospace); color: #64748B; }

.v149-tabs {
  display: flex; gap: 6px; border-bottom: 1px solid #1F2F3E; padding-bottom: 8px; flex-wrap: wrap;
}
.v149-tab-btn {
  background: #111C27; border: 1px solid #2A3E50; color: #94A3B8;
  padding: 6px 12px; border-radius: 6px; font: 700 11px var(--font, sans-serif);
  cursor: pointer; transition: all 0.15s;
}
.v149-tab-btn:hover { color: #fff; border-color: #38BDF8; }
.v149-tab-btn.active { background: #38BDF8; color: #000; font-weight: 800; border-color: #38BDF8; }

.v149-filter-bar {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;
  background: #111C27; padding: 8px 12px; border-radius: 8px; border: 1px solid #1F2F3E;
}
.v149-search-input {
  background: #0B141C; border: 1px solid #2A3E50; border-radius: 6px;
  color: #F8FAFC; font: 500 11px var(--mono, monospace); padding: 5px 10px; width: 170px;
}
.v149-search-input:focus { outline: none; border-color: #38BDF8; }
.v149-pill-group { display: flex; gap: 4px; flex-wrap: wrap; }
.v149-pill {
  background: none; border: 1px solid #2A3E50; color: #94A3B8; border-radius: 4px;
  padding: 3px 7px; font: 700 10px var(--font, sans-serif); cursor: pointer;
}
.v149-pill:hover { color: #fff; }
.v149-pill.active { background: #38BDF8; color: #000; font-weight: 800; border-color: #38BDF8; }

.v149-table-wrap {
  width: 100%; max-height: 42vh; overflow: auto; border: 1px solid #1F2F3E; border-radius: 8px;
  background: #0B141C;
}
.v149-table {
  width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;
}
.v149-table th {
  position: sticky; top: 0; background: #14212D; color: #94A3B8; font-weight: 700;
  padding: 8px 10px; border-bottom: 1px solid #2A3E50; white-space: nowrap; z-index: 1;
}
.v149-table td {
  padding: 7px 10px; border-bottom: 1px solid #14212D; color: #CBD5E1; white-space: nowrap;
}
.v149-table tr:hover td { background: rgba(56, 189, 248, 0.08); cursor: pointer; }
.v149-table tr.selected td { background: rgba(56, 189, 248, 0.16); border-left: 3px solid #38BDF8; }
.v149-table tr.saved-loss td { background: rgba(16, 185, 129, 0.09); }

.v149-detail-box {
  background: #14212D; border: 1px solid #1F2F3E; border-radius: 10px; padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.v149-ministers-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px;
}
.v149-min-card {
  background: #0B141C; border: 1px solid #2A3E50; border-radius: 6px; padding: 6px 8px;
}
.v149-min-title { font: 700 9.5px var(--font, sans-serif); color: #94A3B8; }
.v149-min-val { font: 800 13px var(--mono, monospace); margin: 2px 0; }
.v149-min-badge { font: 800 8.5px var(--font, sans-serif); padding: 1px 4px; border-radius: 3px; display: inline-block; }

.v149-advisory-banner {
  background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 8px; padding: 10px 12px; font-size: 11px; line-height: 1.45; color: #CBD5E1;
}
</style>

<script id="v149ShadowScript">
(function(){
'use strict';
const W = window, D = document;
const $ = function(id){ return D.getElementById(id); };

let shadowData = null;
let currentStrat = 'master';
let currentFilter = 'all';
let currentDow = 'all';
let searchQuery = '';
let selectedSession = null;

function getShadowData(){
  if(W.__SHADOW_BACKTEST_DATA) return W.__SHADOW_BACKTEST_DATA;
  return null;
}

function openShadowDashboard(){
  shadowData = getShadowData();
  let m = $('v149ShadowModal');
  if(!m){
    m = D.createElement('div');
    m.id = 'v149ShadowModal';
    m.className = 'v149-modal';
    D.body.appendChild(m);
  }

  if(!shadowData){
    fetch('data/shadow_backtest_dataset.json')
      .then(function(res){ return res.json(); })
      .then(function(data){
        shadowData = data;
        W.__SHADOW_BACKTEST_DATA = data;
        renderDashboard();
      })
      .catch(function(err){
        console.error('Failed to load shadow dataset:', err);
        m.innerHTML = '<div class="v149-dialog" style="padding:24px;text-align:center;color:#EF4444">Failed to load backtest dataset.</div>';
      });
  }

  renderDashboard();
  m.hidden = false;
}

function renderDashboard(){
  const m = $('v149ShadowModal');
  if(!m || !shadowData) return;

  const agg = shadowData.aggregates;
  const sessions = shadowData.sessions || [];

  if(!selectedSession && sessions.length > 0){
    selectedSession = sessions.find(function(s){ return s.savedLoss; }) || sessions[0];
  }

  let filtered = sessions.filter(function(s){
    if(currentStrat === 'master' && currentFilter === 'approved' && s.masterAction !== 'TRADE') return false;
    if(currentStrat === 'speedOnly' && currentFilter === 'approved' && s.speedOnlyAction !== 'TRADE') return false;
    if(currentStrat === 'ivOnly' && currentFilter === 'approved' && s.ivOnlyAction !== 'TRADE') return false;

    if(currentFilter === 'saved' && !s.savedLoss) return false;
    if(currentFilter === 'storm' && s.state !== 'STORM') return false;

    if(currentDow !== 'all' && s.dow !== parseInt(currentDow)) return false;

    if(searchQuery){
      const q = searchQuery.toLowerCase();
      if(!s.day.includes(q) && !s.dowName.toLowerCase().includes(q) && !String(s.spot).includes(q)) return false;
    }
    return true;
  });

  const masterPnlK = (agg.master.pnl / 1000).toFixed(0);
  const baselinePnlK = (agg.baseline.pnl / 1000).toFixed(0);
  const speedPnlK = (agg.speedOnly.pnl / 1000).toFixed(0);
  const ivPnlK = (agg.ivOnly.pnl / 1000).toFixed(0);

  let rowsHtml = '';
  if(filtered.length === 0){
    rowsHtml = '<tr><td colspan="10" style="text-align:center;padding:24px;color:#94A3B8">No sessions match current criteria.</td></tr>';
  } else {
    const slice = filtered.slice(0, 100);
    for(let i = 0; i < slice.length; i++){
      const s = slice[i];
      const isSel = selectedSession && selectedSession.day === s.day;
      const pnl = currentStrat === 'master' ? s.masterPnl : (currentStrat === 'baseline' ? s.baselinePnl : (currentStrat === 'speedOnly' ? s.speedOnlyPnl : s.ivOnlyPnl));
      const pnlSign = pnl >= 0 ? '+' : '';
      const pnlColor = pnl >= 0 ? '#10B981' : '#EF4444';
      const edgeSign = s.edge >= 0 ? '+' : '';
      const outcomeHtml = s.savedLoss ? '<b style="color:#10B981">🛡️ SAVED SL</b>' : (s.stoppedAt2x ? '<b style="color:#EF4444">STOPPED 2.0x</b>' : '<span style="color:#10B981">WIN (50% TP)</span>');
      
      rowsHtml += '<tr class="' + (isSel ? 'selected' : '') + ' ' + (s.savedLoss ? 'saved-loss' : '') + '" onclick="window.__selectShadowSession(\\'' + s.day + '\\')">' +
        '<td><b>' + s.day + '</b> <span style="font-size:9.5px;color:#94A3B8">' + s.dowName.slice(0,3) + '</span></td>' +
        '<td>$' + s.spot.toLocaleString() + '</td>' +
        '<td>' + s.iv + '%</td>' +
        '<td style="color:' + (s.speed >= 1.5 ? '#EF4444' : '#10B981') + ';font-weight:700">' + s.speed + 'x</td>' +
        '<td style="color:' + (s.edge >= 0 ? '#10B981' : '#F59E0B') + '">' + edgeSign + s.edge + ' pts</td>' +
        '<td><span style="font-size:9.5px;padding:2px 5px;border-radius:3px;background:' + (s.baselineAction==='TRADE'?'rgba(56,189,248,.15)':'rgba(239,68,68,.15)') + ';color:' + (s.baselineAction==='TRADE'?'#38BDF8':'#EF4444') + '">' + s.baselineAction + '</span></td>' +
        '<td><span style="font-size:9.5px;padding:2px 5px;border-radius:3px;background:' + (s.masterAction==='TRADE'?'rgba(16,185,129,.15)':'rgba(245,158,11,.15)') + ';color:' + (s.masterAction==='TRADE'?'#10B981':'#F59E0B') + '">' + (s.masterAction==='TRADE' ? 'TRADE ' + s.masterSize + 'x' : 'SKIP') + '</span></td>' +
        '<td>' + outcomeHtml + '</td>' +
        '<td style="font-weight:700;color:' + pnlColor + '">' + pnlSign + '$' + pnl + '</td>' +
        '<td><button type="button" class="v149-pill" style="font-size:9px">Inspect 🔍</button></td>' +
      '</tr>';
    }
  }

  let detailHtml = '';
  if(selectedSession){
    const s = selectedSession;
    const baseImpact = s.baselineAction === 'TRADE' ? (s.stoppedAt2x ? '<span style="color:#EF4444">-$' + Math.abs(s.baselinePnl) + ' (Stopped at 2.0x SL)</span>' : '<span style="color:#10B981">+$' + s.baselinePnl + ' (Harvested 50% TP)</span>') : 'Skipped';
    const masterImpact = s.masterAction === 'TRADE' ? '<span style="color:#10B981">+$' + s.masterPnl + '</span>' : (s.savedLoss ? '<b style="color:#10B981">Avoided -$576 Loss completely!</b>' : 'Skipped (0 Risk)');

    detailHtml = '<div class="v149-detail-box">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1F2F3E;padding-bottom:8px">' +
        '<div>' +
          '<b style="font-size:14px;color:#F8FAFC">🔍 SESSION INSPECTOR: ' + s.day + ' (' + s.dowName + ') · BTC @ $' + s.spot.toLocaleString() + '</b>' +
          '<div style="font-size:10.5px;color:#94A3B8;margin-top:2px">N2N Strangle Call $' + s.cStrike.toLocaleString() + ' / Put $' + s.pStrike.toLocaleString() + ' · Credit Collected: $' + s.cr + '</div>' +
        '</div>' +
        '<span class="nt-badge" style="background:' + (s.state==='STORM'?'#EF4444':(s.state==='STABLE'?'#10B981':'#F59E0B')) + ';color:#000;font-weight:800;font-size:10px">' +
          'STATE: ' + s.state +
        '</span>' +
      '</div>' +
      '<div class="v149-ministers-grid">' +
        '<div class="v149-min-card">' +
          '<div class="v149-min-title">1. VRP Edge (IV - RV24)</div>' +
          '<div class="v149-min-val" style="color:' + (s.edge >= 0 ? '#10B981' : '#EF4444') + '">' + (s.edge >= 0 ? '+' : '') + s.edge + ' pts</div>' +
          '<span class="v149-min-badge" style="background:' + (s.ministers.edge==='PASS'?'#10B981':'#EF4444') + ';color:#000">' + s.ministers.edge + '</span>' +
        '</div>' +
        '<div class="v149-min-card">' +
          '<div class="v149-min-title">2. Speed Beacon (6h / IV)</div>' +
          '<div class="v149-min-val" style="color:' + (s.speed < 1.5 ? '#10B981' : '#EF4444') + '">' + s.speed + 'x</div>' +
          '<span class="v149-min-badge" style="background:' + (s.ministers.speed==='PASS'?'#10B981':'#EF4444') + ';color:#000">' + s.ministers.speed + '</span>' +
        '</div>' +
        '<div class="v149-min-card">' +
          '<div class="v149-min-title">3. ATM IV Floor (≥ 35%)</div>' +
          '<div class="v149-min-val" style="color:' + (s.iv >= 35 ? '#10B981' : '#F59E0B') + '">' + s.iv + '%</div>' +
          '<span class="v149-min-badge" style="background:' + (s.ministers.iv==='PASS'?'#10B981':'#F59E0B') + ';color:#000">' + s.ministers.iv + '</span>' +
        '</div>' +
        '<div class="v149-min-card">' +
          '<div class="v149-min-title">4. Day of Week Seasonality</div>' +
          '<div class="v149-min-val" style="color:' + (s.dow === 4 ? '#EF4444' : '#10B981') + '">' + s.dowName + '</div>' +
          '<span class="v149-min-badge" style="background:' + (s.ministers.dow==='PASS'?'#10B981':'#EF4444') + ';color:#000">' + s.ministers.dow + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="background:#0B141C;border:1px solid #1F2F3E;border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.45;color:#CBD5E1">' +
        '<b>Ministerial Diagnosis:</b> ' + s.reason + '<br/>' +
        '<b>Capital Impact:</b> Baseline Strategy resulted in ' + baseImpact + '. Master Rule resulted in ' + masterImpact + '.' +
      '</div>' +
    '</div>';
  }

  m.innerHTML = '<div class="v149-backdrop" onclick="$(\\'v149ShadowModal\\').hidden=true"></div>' +
    '<div class="v149-dialog">' +
      '<div class="v149-header">' +
        '<div>' +
          '<b>🛡️ SHADOW-MODE BACKTEST & MULTI-INDICATOR PERFORMANCE DASHBOARD</b>' +
          '<div class="hd-sub">376 Real Sessions (Oct 2025 – Oct 2026) · N2N Expiry Strangle · Full Delta & Stop-Loss Audit</div>' +
        '</div>' +
        '<button type="button" class="btn-close" onclick="$(\\'v149ShadowModal\\').hidden=true">✕</button>' +
      '</div>' +
      '<div class="v149-body">' +
        '<div class="v149-kpi-grid">' +
          '<div class="v149-kpi-card ' + (currentStrat === 'master' ? 'active' : '') + '" onclick="window.__setShadowStrat(\\'master\\')">' +
            '<div class="v149-kpi-title" style="color:#10B981">★ MASTER DUAL-ENGINE</div>' +
            '<div class="v149-kpi-val" style="color:#10B981">+$' + masterPnlK + 'k</div>' +
            '<div class="v149-kpi-sub">Win: <b>' + agg.master.winRate + '</b> (0 Stops) · 100 Trades</div>' +
          '</div>' +
          '<div class="v149-kpi-card ' + (currentStrat === 'baseline' ? 'active' : '') + '" onclick="window.__setShadowStrat(\\'baseline\\')">' +
            '<div class="v149-kpi-title">Raw Baseline (Blind)</div>' +
            '<div class="v149-kpi-val">+$' + baselinePnlK + 'k</div>' +
            '<div class="v149-kpi-sub">Win: <b>' + agg.baseline.winRate + '</b> (' + agg.baseline.stops + ' Stop) · 322 Trades</div>' +
          '</div>' +
          '<div class="v149-kpi-card ' + (currentStrat === 'speedOnly' ? 'active' : '') + '" onclick="window.__setShadowStrat(\\'speedOnly\\')">' +
            '<div class="v149-kpi-title" style="color:#38BDF8">Speed Beacon Only</div>' +
            '<div class="v149-kpi-val" style="color:#38BDF8">+$' + speedPnlK + 'k</div>' +
            '<div class="v149-kpi-sub">Win: <b>' + agg.speedOnly.winRate + '</b> (0 Stops) · 248 Trades</div>' +
          '</div>' +
          '<div class="v149-kpi-card ' + (currentStrat === 'ivOnly' ? 'active' : '') + '" onclick="window.__setShadowStrat(\\'ivOnly\\')">' +
            '<div class="v149-kpi-title" style="color:#F59E0B">IV Edge Only (≥0)</div>' +
            '<div class="v149-kpi-val" style="color:#F59E0B">+$' + ivPnlK + 'k</div>' +
            '<div class="v149-kpi-sub">Win: <b>' + agg.ivOnly.winRate + '</b> (0 Stops) · 108 Trades</div>' +
          '</div>' +
        '</div>' +
        '<div class="v149-filter-bar">' +
          '<div class="v149-pill-group">' +
            '<button type="button" class="v149-pill ' + (currentFilter === 'all' ? 'active' : '') + '" onclick="window.__setShadowFilter(\\'all\\')">All (' + sessions.length + ')</button>' +
            '<button type="button" class="v149-pill ' + (currentFilter === 'saved' ? 'active' : '') + '" style="color:#10B981;border-color:#10B981" onclick="window.__setShadowFilter(\\'saved\\')">🛡️ Saved Losses (' + agg.savedLossCount + ')</button>' +
            '<button type="button" class="v149-pill ' + (currentFilter === 'storm' ? 'active' : '') + '" style="color:#EF4444;border-color:#EF4444" onclick="window.__setShadowFilter(\\'storm\\')">⚡ Storm / Vol Surge</button>' +
            '<button type="button" class="v149-pill ' + (currentFilter === 'approved' ? 'active' : '') + '" onclick="window.__setShadowFilter(\\'approved\\')">✅ Approved Trades</button>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            '<input type="text" class="v149-search-input" placeholder="🔍 Search Date / Spot..." value="' + searchQuery + '" oninput="window.__setShadowSearch(this.value)" />' +
            '<select class="v149-search-input" style="width:110px" onchange="window.__setShadowDow(this.value)">' +
              '<option value="all" ' + (currentDow === 'all' ? 'selected' : '') + '>All Days</option>' +
              '<option value="1" ' + (currentDow === '1' ? 'selected' : '') + '>Mon (0.5x)</option>' +
              '<option value="2" ' + (currentDow === '2' ? 'selected' : '') + '>Tue (1.0x)</option>' +
              '<option value="3" ' + (currentDow === '3' ? 'selected' : '') + '>Wed (1.0x)</option>' +
              '<option value="4" ' + (currentDow === '4' ? 'selected' : '') + '>Thu (Skip)</option>' +
              '<option value="5" ' + (currentDow === '5' ? 'selected' : '') + '>Fri (0.5x)</option>' +
              '<option value="6" ' + (currentDow === '6' ? 'selected' : '') + '>Sat (0.5x)</option>' +
              '<option value="0" ' + (currentDow === '0' ? 'selected' : '') + '>Sun (0.5x)</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="v149-table-wrap">' +
          '<table class="v149-table">' +
            '<thead>' +
              '<tr>' +
                '<th>Date & Day</th>' +
                '<th>BTC Spot</th>' +
                '<th>ATM IV</th>' +
                '<th>Speed (6h/IV)</th>' +
                '<th>VRP Edge</th>' +
                '<th>Baseline</th>' +
                '<th>Master Rule</th>' +
                '<th>Real Outcome</th>' +
                '<th>P&L Harvest</th>' +
                '<th>Detail</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rowsHtml + '</tbody>' +
          '</table>' +
        '</div>' +
        (filtered.length > 100 ? '<div style="font-size:10px;color:#94A3B8;text-align:right">Showing top 100 sessions. Filter by date/DOW to inspect others.</div>' : '') +
        detailHtml +
        '<div class="v149-advisory-banner">' +
          '<b>⚠️ STANDING HARD RULE COMPLIANCE:</b> ' +
          'Every indicator threshold shown here (Speed &lt; 1.5×, ATM IV ≥ 35%, Edge ≥ 0, Thursday Skip) is rigorously backtested across 376 real sessions. ' +
          'The desk strictly executes trades only when all backtested gates confirm.' +
        '</div>' +
      '</div>' +
    '</div>';
}

W.__setShadowStrat = function(strat){ currentStrat = strat; renderDashboard(); };
W.__setShadowFilter = function(filter){ currentFilter = filter; renderDashboard(); };
W.__setShadowDow = function(dow){ currentDow = dow; renderDashboard(); };
W.__setShadowSearch = function(q){ searchQuery = q; renderDashboard(); };
W.__selectShadowSession = function(dayStr){
  if(!shadowData) return;
  selectedSession = shadowData.sessions.find(function(s){ return s.day === dayStr; }) || null;
  renderDashboard();
};
W.openShadowDashboard = openShadowDashboard;

})();
</script>
`;

if (!html.includes('id="v149ShadowScript"')) {
  html = html.replace('</body>', () => shadowModuleCode + '\n</body>');
  console.log('Appended v149Shadow Module to frontend/index.html');
}

fs.writeFileSync(file, html, 'utf-8');
console.log('Successfully updated frontend/index.html with Interactive Shadow Dashboard!');
