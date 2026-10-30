const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

function findBlock(name) {
  const idx = content.indexOf(name);
  if (idx === -1) {
    console.log('NOT FOUND:', name);
    return;
  }
  console.log('=== FOUND:', name, 'at', idx, '===');
  console.log(content.slice(idx, idx + 1500));
}

findBlock('data-block="pnl-chart"');
findBlock('id="dkUi"');
findBlock('id="askTrade"');
findBlock('data-module="vLivePnlTick"');

