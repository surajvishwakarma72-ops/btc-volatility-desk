const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function attachContinuousCrosshair');
console.log(html.slice(sIdx + 1800, sIdx + 3800));

