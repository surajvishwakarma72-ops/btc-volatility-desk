const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = 3780195;
console.log('Around 3780195:');
console.log(html.slice(sIdx - 300, sIdx + 1200));

const eIdx = 3830961;
console.log('\nAround 3830961:');
console.log(html.slice(eIdx - 200, eIdx + 500));

