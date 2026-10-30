const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('vUniversalFloatingPnl');
console.log('vUniversalFloatingPnl at:', sIdx);
console.log(html.slice(sIdx - 400, sIdx + 1200));

