const fs = require('fs');
const content = fs.readFileSync('frontend/index.html', 'utf8');

const pnlStart = content.indexOf('data-module="vLivePnlTick"');

console.log('--- Chunk 2 ---');
console.log(content.slice(pnlStart + 4000, pnlStart + 10000));

