const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

const pnlStart = content.indexOf('data-module="vLivePnlTick"');
const pnlEnd = content.indexOf('</script>', pnlStart);

console.log('vLivePnlTick length:', pnlEnd - pnlStart);
console.log(content.slice(pnlStart, pnlStart + 4000));

