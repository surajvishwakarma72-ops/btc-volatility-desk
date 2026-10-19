const fs = require('fs');

const file = 'frontend/index.html';
let html = fs.readFileSync(file, 'utf-8');

// 1. Add LSg and LSs definition inside v148Economy
const v148Start = '<script data-module="v148Economy">\n(function(){\n\'use strict\';\nconst W=window, D=document, $=id=>D.getElementById(id);\nconst MIN=60000, HR=3600000, DAY=86400000, IST=19800000;';

const lsgHelpers = `
function LSg(key, defVal){
  try{
    const v = localStorage.getItem(key);
    return v !== null ? JSON.parse(v) : defVal;
  }catch(e){
    return defVal;
  }
}
function LSs(key, val){
  try{
    localStorage.setItem(key, JSON.stringify(val));
  }catch(e){}
}`;

if (!html.includes('function LSg(key, defVal)') && html.includes(v148Start)) {
  html = html.replace(v148Start, () => v148Start + '\n' + lsgHelpers);
  console.log('Added LSg and LSs helpers to v148Economy script');
}

// 2. Add "Internal News" button to gTop toolbar right next to Clock button
const clockBtnTarget = "const clk=D.createElement('button');clk.type='button';clk.id='v147ClockBtn';";
const newsBtnToolbar = `
  const newsBtn=D.createElement('button');
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
`;

if (!html.includes('id=\'v148ToolbarNewsBtn\'') && html.includes(clockBtnTarget)) {
  html = html.replace(clockBtnTarget, () => newsBtnToolbar + '\n  ' + clockBtnTarget);
  console.log('Added Internal News button to gTop chart toolbar');
}

// 3. Update CSS for Ticker and Badge to sit cleanly beside the clock at top: 42px; left: 175px
const targetCss = `#v148NewsTicker{position:absolute;top:6px;left:8px;right:8px;z-index:12;height:30px;background:rgba(14,20,27,.94);backdrop-filter:blur(8px);border-radius:8px;border:1px solid var(--line2,#2A3E50);display:flex;align-items:center;padding:0 10px;font-family:var(--font);color:var(--text,#F8FAFC);gap:10px;cursor:pointer;transition:border-color .2s,box-shadow .2s;box-shadow:0 4px 14px rgba(0,0,0,.4);box-sizing:border-box}`;

const improvedCss = `#v148NewsTicker{position:absolute;top:42px;left:clamp(135px,16vw,178px);right:12px;z-index:12;height:34px;background:rgba(14,20,27,.94);backdrop-filter:blur(8px);border-radius:8px;border:1px solid var(--line2,#2A3E50);display:flex;align-items:center;padding:0 10px;font-family:var(--font);color:var(--text,#F8FAFC);gap:10px;cursor:pointer;transition:border-color .2s,box-shadow .2s;box-shadow:0 4px 14px rgba(0,0,0,.4);box-sizing:border-box}
#v148EconomyBadge{position:absolute;top:82px;left:clamp(135px,16vw,178px);z-index:11;background:rgba(17,28,39,.94);backdrop-filter:blur(6px);border:1px solid var(--line2,#2A3E50);border-radius:8px;padding:6px 10px;font-family:var(--font);color:var(--text,#F8FAFC);font-size:11px;display:flex;flex-direction:column;gap:3px;box-shadow:0 4px 12px rgba(0,0,0,.35);cursor:pointer;transition:border-color .15s}
#v148EconomyBadge:hover{border-color:var(--focus,#38BDF8)}`;

if (html.includes(targetCss)) {
  html = html.replace(targetCss, () => improvedCss);
  console.log('Updated Ticker and Badge positioning beside trade clock');
}

// 4. Update paintEconomy so that toolbar unread badge also updates
const targetPaintEconomyEnd = "ticker.innerHTML = `";
const replacementPaintEconomy = `
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

  ticker.innerHTML = \``;

if (html.includes(targetPaintEconomyEnd) && !html.includes('Update Toolbar News Badge')) {
  html = html.replace(targetPaintEconomyEnd, () => replacementPaintEconomy);
  console.log('Updated paintEconomy to sync toolbar badge');
}

fs.writeFileSync(file, html, 'utf-8');
console.log('Successfully patched frontend/index.html with Internal News visibility fixes!');
