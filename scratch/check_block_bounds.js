import fs from 'fs';

['frontend/index.html', 'Volatility Desk.html'].forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  const sIdx = content.indexOf('<style id="vLivePnlTickCss">');
  const bIdx = content.indexOf('</body>', sIdx);
  const eIdx = content.lastIndexOf('</script>', bIdx);
  console.log(f, 'sIdx:', sIdx, 'eIdx:', eIdx, 'bIdx:', bIdx);
});

