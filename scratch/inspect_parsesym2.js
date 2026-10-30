const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('parseSym');
console.log('parseSym index:', sIdx);
if (sIdx > -1) {
  console.log(html.slice(sIdx - 50, sIdx + 1000));
}

