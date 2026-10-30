const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('vLivePnlTick');
console.log('vLivePnlTick found at:', sIdx);
console.log(html.slice(sIdx - 500, sIdx + 1500));

