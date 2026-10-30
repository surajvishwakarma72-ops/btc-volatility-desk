const fs = require('fs');
const content = fs.readFileSync('frontend/index.html', 'utf8');

const pnlStart = content.indexOf('data-module="vLivePnlTick"');

console.log('--- Chunk 5 ---');
console.log(content.slice(pnlStart + 24000, pnlStart + 32000));

