const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('v158-deep');
console.log(html.slice(sIdx + 800, sIdx + 2800));

