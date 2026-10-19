const fs = require('fs');

const file = 'frontend/index.html';
let html = fs.readFileSync(file, 'utf-8');

// 1. Hide in CSS
html = html.replace(
  '/* Breaking-News Ticker across top edge of chart */',
  '/* Black strips completely removed from chart canvas */\n#v148NewsTicker, #v148EconomyBadge{display:none !important;visibility:hidden !important;opacity:0 !important;pointer-events:none !important}'
);

// 2. Remove JavaScript mounting and rendering of on-chart ticker and badge
const jsOldStart = '/* ---------- UI Mounting & Painting ---------- */';
const jsOldEnd = '// Update Badge';

const jsIndexStart = html.indexOf(jsOldStart);
const jsIndexEnd = html.indexOf(jsOldEnd);

if (jsIndexStart !== -1 && jsIndexEnd !== -1) {
  // Find where paintEconomy finishes updating badge
  const nextSectionIndex = html.indexOf('/* ---------- Pop-up Details Dialog ---------- */', jsIndexEnd);
  if (nextSectionIndex !== -1) {
    const cleanLogic = `/* ---------- Clean Toolbar & Drawer Synchronization (No on-chart strips) ---------- */
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
}

`;
    html = html.slice(0, jsIndexStart) + cleanLogic + html.slice(nextSectionIndex);
    console.log('Successfully eliminated on-chart mounting logic');
  }
}

fs.writeFileSync(file, html, 'utf-8');
console.log('Successfully removed the black strip from chart!');
