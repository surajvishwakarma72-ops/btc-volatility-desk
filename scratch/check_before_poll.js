const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function pollDeltaPositions()');
console.log(html.slice(sIdx - 1500, sIdx - 50));

