const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

const idx = content.indexOf('data-block="desk-auth"');
console.log('desk-auth at:', idx);
if (idx !== -1) {
  console.log(content.slice(idx, idx + 2500));
}

