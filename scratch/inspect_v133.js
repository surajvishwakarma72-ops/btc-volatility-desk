const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('data-module="v133"');
console.log('v133 module start:', sIdx);
console.log(html.slice(sIdx, sIdx + 3000));

