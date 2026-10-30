const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function analyse(R)');
console.log(html.slice(sIdx - 1000, sIdx));

