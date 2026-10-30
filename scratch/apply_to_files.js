const fs = require('fs');

function applyTo(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const startTag = '<style id="vLivePnlTickCss">';
  const endTag = '</body>';

  const sIdx = content.indexOf(startTag);
  const eIdx = content.indexOf(endTag, sIdx);

  if (sIdx === -1 || eIdx === -1) {
    console.error('Could not find boundaries in', filePath);
    return;
  }

  const replacement = fs.readFileSync('scratch/replacement_module.txt', 'utf8');
  const newContent = content.slice(0, sIdx) + replacement + '\n' + content.slice(eIdx);

  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log('Successfully applied replacement module to', filePath);
}

applyTo('frontend/index.html');
applyTo('Volatility Desk.html');

