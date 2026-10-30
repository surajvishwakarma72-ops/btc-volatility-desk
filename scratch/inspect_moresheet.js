const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('id="moreSheet"');
console.log('moreSheet HTML:');
console.log(html.slice(sIdx - 100, sIdx + 500));

