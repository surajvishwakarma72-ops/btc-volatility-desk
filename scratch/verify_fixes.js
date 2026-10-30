const fs = require('fs');

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  console.log('=== Checking', filePath, '===');
  console.log('Includes not(#vLivePnlTick):', content.includes(':not(#vLivePnlTick)'));
  console.log('Includes moreTab stopPropagation:', content.includes('e.stopPropagation();const s=$(\x27moreSheet\x27)') || content.includes('e.stopPropagation();\n        const s = $(\x27moreSheet\x27)'));
  console.log('Includes Delta (Read-Only):', content.includes('Delta (Read-Only)'));
  console.log('Includes Read + Trade:', content.includes('Read + Trade'));
  console.log('Includes v-acc-tabs:', content.includes('v-acc-tabs'));
}

checkFile('frontend/index.html');
checkFile('Volatility Desk.html');

