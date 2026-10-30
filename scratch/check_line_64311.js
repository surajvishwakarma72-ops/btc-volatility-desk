const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const lines = html.split('\n');
console.log('Around line 64311:');
for (let i = 64305; i < 64335; i++) {
  if (lines[i]) console.log(`${i+1}: ${lines[i]}`);
}

