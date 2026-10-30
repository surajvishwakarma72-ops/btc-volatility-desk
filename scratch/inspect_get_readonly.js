const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function getReadOnlyLastClosedTrade');
console.log(html.slice(sIdx - 200, sIdx + 2000));

