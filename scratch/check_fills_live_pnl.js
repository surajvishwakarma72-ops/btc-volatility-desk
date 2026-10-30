const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function pollFills()');
console.log('pollFills index:', sIdx);
if (sIdx > -1) {
  console.log(html.slice(sIdx - 50, sIdx + 1200));
} else {
  // search for fills in live pnl module
  const start = html.indexOf('Delta Live Tick-by-Tick & Start-to-Exit P&L System');
  console.log('Live PnL module found:', start);
  console.log(html.slice(start, start + 3000));
}

