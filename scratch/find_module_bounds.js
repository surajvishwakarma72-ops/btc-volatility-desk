const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('/** Ensure pgPnl exists in DOM at proper place */');
const endIdx = html.indexOf('// v105.15 · one beat for the page\'s clocks');
console.log('Start:', sIdx, 'End:', endIdx);
console.log(html.slice(sIdx - 1000, sIdx + 500));

