const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('const u = \'/api/v1/delta/signed?path=/v2/positions/margined');
console.log(html.slice(sIdx - 100, sIdx + 400));

