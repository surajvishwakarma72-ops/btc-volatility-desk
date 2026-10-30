const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('v158Deep');
console.log(html.slice(sIdx + 2800, sIdx + 4800));

