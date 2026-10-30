const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('const curve = candles.map');
console.log(html.slice(sIdx - 50, sIdx + 800));

