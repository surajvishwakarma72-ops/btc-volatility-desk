const fs = require('fs');

let content = fs.readFileSync('Volatility Desk.html', 'utf8');

const target1 = `$('moreTab')?.addEventListener('click',()=>{const s=$('moreSheet');if(s)s.hidden=!s.hidden;});   $('moreTheme')?.addEventListener('click',()=>{const s=$('moreSheet');if(s){s.hidden=true;s.style.display='none';}});   $('moreLock')?.addEventListener('click',()=>{const s=$('moreSheet');if(s){s.hidden=true;s.style.display='none';}});   document.addEventListener('click',e=>{const s=$('moreSheet');if(s&&!s.hidden&&!e.target.closest('#moreSheet,#moreTab'))s.hidden=true;});`;

// Let's check what exactly is in Volatility Desk.html around moreTab click
const idx = content.indexOf(`$('moreTab')?.addEventListener('click'`);
console.log('Snippet in Volatility Desk.html:');
console.log(content.slice(idx, idx + 400));

const oldBlock = content.slice(idx, content.indexOf(';', content.indexOf(`!e.target.closest('#moreSheet,#moreTab'))s.hidden=true;`) + 1));
console.log('\nOld block:');
console.log(oldBlock);

const newBlock = `$('moreTab')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const s=$('moreSheet');if(s){const willOpen=s.hidden||s.style.display==='none';s.hidden=!willOpen;s.style.display=willOpen?'flex':'none';}});   $('moreTheme')?.addEventListener('click',()=>{const s=$('moreSheet');if(s){s.hidden=true;s.style.display='none';}});   $('moreLock')?.addEventListener('click',()=>{const s=$('moreSheet');if(s){s.hidden=true;s.style.display='none';}});   document.addEventListener('click',e=>{const s=$('moreSheet');if(s&&!s.hidden&&!e.target.closest('#moreSheet,#moreTab')){s.hidden=true;s.style.display='none';}});`;

content = content.replace(oldBlock, newBlock);

const targetV158Css = `#pgPnl.v158-deep > :not(#v158Deep){display:none!important}`;
const replV158Css = `#pgPnl.v158-deep > :not(#v158Deep):not(#vLivePnlTick){display:none!important}`;
if (content.includes(targetV158Css)) {
  content = content.split(targetV158Css).join(replV158Css);
}

fs.writeFileSync('Volatility Desk.html', content, 'utf8');
console.log('Successfully updated Volatility Desk.html');

