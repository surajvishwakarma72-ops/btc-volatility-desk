const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('enhanceV133EquityCurve');
console.log(html.slice(sIdx, sIdx + 2000));

