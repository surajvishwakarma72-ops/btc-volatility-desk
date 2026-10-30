const fs = require('fs');
const content = fs.readFileSync('frontend/index.html', 'utf8');

const pnlStart = content.indexOf('data-module="vLivePnlTick"');

console.log('--- Chunk 4 ---');
console.log(content.slice(pnlStart + 16000, pnlStart + 24000));

