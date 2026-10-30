const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('Delta Live Tick-by-Tick & Start-to-Exit P&L System');
if (sIdx > -1) {
  console.log('Found comment at:', sIdx);
  const endIdx = html.indexOf('</script>', sIdx);
  console.log('Script ends at:', endIdx);
  console.log(html.slice(endIdx - 100, endIdx + 20));
} else {
  const matches = [...html.matchAll(/vLivePnlTick/g)];
  matches.forEach(m => console.log('Match at', m.index));
}

