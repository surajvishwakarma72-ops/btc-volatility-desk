const fs = require('fs');

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // 1. Fix moreTab click handler and outside click handler in v80 (around line 31674)
  const target1 = `      $('moreTab')?.addEventListener('click', () => { const s = $('moreSheet'); if (s) s.hidden = !s.hidden; });
      $('moreTheme')?.addEventListener('click', () => { $('themeBtn')?.click(); $('moreSheet').hidden = true; });
      $('moreLock')?.addEventListener('click', () => { $('lockBtn')?.click(); });
      document.addEventListener('click', e => { const s = $('moreSheet'); if (s && !s.hidden && !e.target.closest('#moreSheet,#moreTab')) s.hidden = true; });`;

  const repl1 = `      // Fixed moreTab toggle and document click to prevent blinking/instant closure
      $('moreTab')?.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const s = $('moreSheet');
        if (s) {
          const willOpen = s.hidden || s.style.display === 'none';
          s.hidden = !willOpen;
          s.style.display = willOpen ? 'flex' : 'none';
        }
      });
      $('moreTheme')?.addEventListener('click', () => { $('themeBtn')?.click(); const s = $('moreSheet'); if (s) { s.hidden = true; s.style.display = 'none'; } });
      $('moreLock')?.addEventListener('click', () => { $('lockBtn')?.click(); });
      document.addEventListener('click', e => {
        const s = $('moreSheet');
        if (s && !s.hidden && !e.target.closest('#moreSheet, #moreTab')) {
          s.hidden = true;
          s.style.display = 'none';
        }
      });`;

  if (content.includes(target1)) {
    content = content.replace(target1, repl1);
    console.log('Successfully patched moreTab listener in', filePath);
  } else {
    console.warn('Target 1 not found in', filePath);
  }

  // 2. Fix show() function so $('moreSheet') is hidden properly with display: none
  const targetShow = `$('moreSheet') && ($('moreSheet').hidden = true);`;
  const replShow = `const _ms = $('moreSheet'); if (_ms) { _ms.hidden = true; _ms.style.display = 'none'; }`;
  if (content.includes(targetShow)) {
    content = content.split(targetShow).join(replShow);
    console.log('Successfully patched show() moreSheet hiding in', filePath);
  }

  // 3. Fix v158 css rule that was hiding everything inside #pgPnl except #v158Deep
  // Target: #pgPnl.v158-deep > :not(#v158Deep){display:none!important}
  const targetV158Css = `#pgPnl.v158-deep > :not(#v158Deep){display:none!important}`;
  const replV158Css = `#pgPnl.v158-deep > :not(#v158Deep):not(#vLivePnlTick){display:none!important}`;
  if (content.includes(targetV158Css)) {
    content = content.split(targetV158Css).join(replV158Css);
    console.log('Successfully preserved #vLivePnlTick in v158-deep in', filePath);
  }

  fs.writeFileSync(filePath, content, 'utf8');
}

patchFile('frontend/index.html');
patchFile('Volatility Desk.html');

