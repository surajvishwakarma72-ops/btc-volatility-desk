const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

const idx = content.indexOf('data-module="v100"');
console.log('v100 at:', idx);
if (idx !== -1) {
  console.log(content.slice(idx, idx + 2500));
}

