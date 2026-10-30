const fs = require('fs');
const content = fs.readFileSync('frontend/index.html', 'utf8');

const pnlStart = content.indexOf('data-module="vLivePnlTick"');

console.log('--- Chunk 3 ---');
console.log(content.slice(pnlStart + 10000, pnlStart + 16000));

