const fs = require('fs');

const file = 'frontend/index.html';
let html = fs.readFileSync(file, 'utf-8');

// 1. Update toolbar button creation to insert both Economy State button and News button
const oldToolbarSnippet = `  const newsBtn=D.createElement('button');
  newsBtn.type='button';
  newsBtn.id='v148ToolbarNewsBtn';
  newsBtn.className='tool';
  newsBtn.title='National Economy Breaking News & Minister Bulletins';
  newsBtn.innerHTML='<b style="color:#38BDF8">📰</b> Internal News <span class="v148-tb-badge" id="v148TbUnread" style="display:none;background:#EF4444;color:#fff;font-size:9px;font-weight:800;padding:1px 5px;border-radius:8px;margin-left:4px"></span>';
  newsBtn.addEventListener('click', e => {
    e.stopPropagation();
    try { W.v148Economy && W.v148Economy.openLog ? W.v148Economy.openLog() : null; } catch(x){}
  });
  r.insertBefore(newsBtn, r.firstChild);`;

const newToolbarSnippet = `  const newsBtn=D.createElement('button');
  newsBtn.type='button';
  newsBtn.id='v148ToolbarNewsBtn';
  newsBtn.className='tool';
  newsBtn.title='National Economy Breaking News & Minister Bulletins';
  newsBtn.innerHTML='<b style="color:#38BDF8">📰</b> Internal News <span class="v148-tb-badge" id="v148TbUnread" style="display:none;background:#EF4444;color:#fff;font-size:9px;font-weight:800;padding:1px 5px;border-radius:8px;margin-left:4px"></span>';
  newsBtn.addEventListener('click', e => {
    e.stopPropagation();
    try { W.v148Economy && W.v148Economy.openLog ? W.v148Economy.openLog() : null; } catch(x){}
  });
  r.insertBefore(newsBtn, r.firstChild);

  const ecoBtn=D.createElement('button');
  ecoBtn.type='button';
  ecoBtn.id='v148ToolbarEcoBtn';
  ecoBtn.className='tool';
  ecoBtn.title='National Economy State & Mandated Lots — Click for Expert Diagnosis';
  ecoBtn.innerHTML='<span id="v148EcoStatusPill" style="display:inline-flex;align-items:center;gap:4px;font-weight:800;color:#10B981">🏛️ STABLE · 1.0x</span>';
  ecoBtn.addEventListener('click', e => {
    e.stopPropagation();
    try { W.v148Economy && W.v148Economy.openNews ? W.v148Economy.openNews() : null; } catch(x){}
  });
  r.insertBefore(ecoBtn, r.firstChild);`;

if (html.includes(oldToolbarSnippet)) {
  html = html.replace(oldToolbarSnippet, () => newToolbarSnippet);
  console.log('Added Eco status button and News button to gTop toolbar');
}

// 2. Add Toast notification styling and remove ugly chart strip styling
const oldCssStrip = `#v148NewsTicker{position:absolute;top:42px;left:clamp(135px,16vw,178px);right:12px;z-index:12;height:34px;background:rgba(14,20,27,.94);backdrop-filter:blur(8px);border-radius:8px;border:1px solid var(--line2,#2A3E50);display:flex;align-items:center;padding:0 10px;font-family:var(--font);color:var(--text,#F8FAFC);gap:10px;cursor:pointer;transition:border-color .2s,box-shadow .2s;box-shadow:0 4px 14px rgba(0,0,0,.4);box-sizing:border-box}
#v148EconomyBadge{position:absolute;top:82px;left:clamp(135px,16vw,178px);z-index:11;background:rgba(17,28,39,.94);backdrop-filter:blur(6px);border:1px solid var(--line2,#2A3E50);border-radius:8px;padding:6px 10px;font-family:var(--font);color:var(--text,#F8FAFC);font-size:11px;display:flex;flex-direction:column;gap:3px;box-shadow:0 4px 12px rgba(0,0,0,.35);cursor:pointer;transition:border-color .15s}
#v148EconomyBadge:hover{border-color:var(--focus,#38BDF8)}
#v148NewsTicker:hover{border-color:var(--focus,#38BDF8)}`;

const newCleanCss = `/* Hide obstructive black strips on chart canvas */
#v148NewsTicker, #v148EconomyBadge { display: none !important; }

/* Elegant Floating Toast Notification for Breaking News (Auto-dismisses in 6s) */
.v148-toast {
  position: fixed; top: 58px; right: 24px; z-index: 99999;
  background: rgba(14, 23, 33, 0.96); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--line2, #2A3E50); border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0,0,0,0.7), 0 0 20px rgba(56,189,248,0.2);
  padding: 12px 16px; max-width: 440px; display: flex; flex-direction: column; gap: 6px;
  font-family: var(--font); color: var(--text, #F8FAFC);
  animation: toastSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  cursor: pointer; transition: all 0.2s ease;
}
.v148-toast:hover { transform: translateY(-2px); border-color: var(--focus, #38BDF8); }
.v148-toast.state-storm { border-left: 4px solid #EF4444; }
.v148-toast.state-crisis { border-left: 4px solid #EF4444; }
.v148-toast.state-inflation { border-left: 4px solid #F59E0B; }
.v148-toast.state-rumour { border-left: 4px solid #EAB308; }
.v148-toast.state-stable { border-left: 4px solid #10B981; }

@keyframes toastSlideIn {
  from { opacity: 0; transform: translateY(-16px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}`;

if (html.includes(oldCssStrip)) {
  html = html.replace(oldCssStrip, () => newCleanCss);
  console.log('Replaced black strip CSS with clean toast CSS');
}

// 3. Update UI painting logic to remove chart canvas elements and update toolbar & toast
const oldMountAndPaint = `/* ---------- UI Mounting & Painting ---------- */
function mountTicker(){
  const box = D.querySelector('#paneG .chart-box');
  if(!box) return null;
  let t = $('v148NewsTicker');
  if(!t){
    t = D.createElement('div');
    t.id = 'v148NewsTicker';
    t.title = 'National Economy Breaking News Ticker — Click to view expert indicator diagnosis';
    box.appendChild(t);
    t.addEventListener('click', function(e){
      e.stopPropagation();
      openNewsModal();
    });
  }
  return t;
}

function mountBadge(){
  const box = D.querySelector('#paneG .chart-box');
  if(!box) return null;
  let b = $('v148EconomyBadge');
  if(!b){
    b = D.createElement('div');
    b.id = 'v148EconomyBadge';
    b.title = 'National Economy Status — Click for details';
    box.appendChild(b);
    b.addEventListener('click', function(e){
      e.stopPropagation();
      openNewsModal();
    });
  }
  return b;
}

let lastReport = null;
function paintEconomy(){
  const ticker = mountTicker();
  const badge = mountBadge();
  if(!ticker || !badge) return;
  
  const report = evaluateEconomy();
  lastReport = report;
  saveNewsFlash(report);
  
  // Update Ticker
  ticker.className = report.tickerCls;
  
  // Update Toolbar News Badge
  const tbUnread = $('v148TbUnread');
  if(tbUnread){
    if(unreadCount > 0){
      tbUnread.style.display = 'inline-block';
      tbUnread.textContent = unreadCount + ' NEW';
    } else {
      tbUnread.style.display = 'none';
    }
  }

  ticker.innerHTML = \`
    <span class="nt-dot"></span>
    <span class="nt-meta">\${report.timeStr} <span class="nt-session-tag \${report.coverage.sessionCls}">\${report.coverage.sessionLabel}</span></span>
    <div class="nt-headline-wrap">
      <span class="nt-badge \${report.badgeCls}">\${report.state}</span>
      <span class="nt-headline">\${report.headline}</span>
    </div>
    <span class="nt-policy-pill">\${report.policy}</span>
    <button type="button" class="nt-btn-log \${unreadCount > 0 ? 'has-unread' : ''}" id="v148BtnLog">📰 Internal News \${unreadCount > 0 ? \`<span class="nt-unread-pill">\${unreadCount} NEW</span>\` : ''}</button>
  \`;
  
  const btnLog = $('v148BtnLog');
  if(btnLog){
    btnLog.addEventListener('click', function(e){
      e.stopPropagation();
      openNewsLogModal();
    });
  }
  
  // Update Badge
  const stateIcon = report.state === 'STABLE' ? '🏛️' : report.state === 'STORM' ? '⚡' : report.state === 'INFLATION' ? '📈' : report.state === 'CRISIS' ? '📉' : report.state === 'RUMOUR' ? '⚠️' : '💤';
  badge.innerHTML = \`
    <div class="eb-row1">
      <span class="eb-state \${report.badgeCls}">\${stateIcon} \${report.state}</span>
      <span class="eb-policy">\${report.policy.split('·')[0].trim()}</span>
    </div>
    <div class="eb-row2">
      <span>\${report.coverage.sessionLabel}</span>
      <span class="eb-countdown">\${report.coverage.countdownStr}</span>
    </div>
  \`;
}`;

const cleanMountAndPaint = `/* ---------- Clean Toast & Toolbar Notification Engine ---------- */
function showNewsToast(report){
  let t = $('v148NewsToast');
  if(t) t.remove();
  
  t = D.createElement('div');
  t.id = 'v148NewsToast';
  t.className = 'v148-toast ' + report.tickerCls;
  
  const stateIcon = report.state === 'STABLE' ? '🏛️' : report.state === 'STORM' ? '⚡' : report.state === 'INFLATION' ? '📈' : report.state === 'CRISIS' ? '📉' : report.state === 'RUMOUR' ? '⚠️' : '💤';
  t.innerHTML = \`
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="display:flex;align-items:center;gap:6px">
        <span class="nt-badge \${report.badgeCls}">\${stateIcon} \${report.state}</span>
        <span style="font:700 10.5px var(--mono,monospace);color:var(--muted,#94A3B8)">\${report.timeStr}</span>
      </div>
      <button type="button" style="background:none;border:none;color:#94A3B8;cursor:pointer;font-size:14px" onclick="event.stopPropagation();$('v148NewsToast').remove()">✕</button>
    </div>
    <div style="font:800 12.5px var(--font);color:var(--text,#F8FAFC)">\${report.headline}</div>
    <div style="font:600 11px var(--mono,monospace);color:#38BDF8;background:rgba(56,189,248,.1);padding:4px 8px;border-radius:4px;border:1px solid rgba(56,189,248,.25)">
      📋 \${report.policy}
    </div>
  \`;
  
  t.addEventListener('click', function(){
    t.remove();
    openNewsModal();
  });
  
  D.body.appendChild(t);
  setTimeout(function(){ if(t && t.parentNode) t.remove(); }, 6500);
}

let lastReport = null;
function paintEconomy(){
  // Remove any legacy on-chart elements to keep chart canvas 100% clean
  const oldT = $('v148NewsTicker'); if(oldT) oldT.remove();
  const oldB = $('v148EconomyBadge'); if(oldB) oldB.remove();

  const report = evaluateEconomy();
  lastReport = report;
  saveNewsFlash(report);
  
  // Update Toolbar Economy State Pill
  const ecoPill = $('v148EcoStatusPill');
  if(ecoPill){
    const stateIcon = report.state === 'STABLE' ? '🏛️' : report.state === 'STORM' ? '⚡' : report.state === 'INFLATION' ? '📈' : report.state === 'CRISIS' ? '📉' : report.state === 'RUMOUR' ? '⚠️' : '💤';
    const stateColor = report.state === 'STABLE' ? '#10B981' : report.state === 'STORM' ? '#EF4444' : report.state === 'INFLATION' ? '#F59E0B' : report.state === 'CRISIS' ? '#EF4444' : '#EAB308';
    const lotShort = report.policy.split('·')[0].replace('Lots','').replace('Lot','').trim();
    ecoPill.style.color = stateColor;
    ecoPill.innerHTML = stateIcon + ' ' + report.state + ' <span style="font-weight:600;font-size:10.5px;color:var(--text,#E2E8F0);margin-left:2px">· ' + lotShort + '</span>';
  }
  
  // Update Toolbar News Badge
  const tbUnread = $('v148TbUnread');
  if(tbUnread){
    if(unreadCount > 0){
      tbUnread.style.display = 'inline-block';
      tbUnread.textContent = unreadCount + ' NEW';
    } else {
      tbUnread.style.display = 'none';
    }
  }
}`;

if (html.includes('/* ---------- UI Mounting & Painting ---------- */')) {
  html = html.replace(oldMountAndPaint, () => cleanMountAndPaint);
  console.log('Cleaned up paintEconomy to use toolbar and toast notifications');
}

// 4. Update saveNewsFlash to call showNewsToast on alert
const oldSaveFlash = "playNewsAlert(flash.severity, flash.state);";
const newSaveFlash = `playNewsAlert(flash.severity, flash.state);
      showNewsToast(flash);`;

if (html.includes(oldSaveFlash) && !html.includes('showNewsToast(flash);')) {
  html = html.replace(oldSaveFlash, () => newSaveFlash);
  console.log('Connected showNewsToast to saveNewsFlash');
}

fs.writeFileSync(file, html, 'utf-8');
console.log('Successfully organized Internal News & Economy Status UI!');
