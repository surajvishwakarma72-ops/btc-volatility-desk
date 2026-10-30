const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

function find(str, len = 2500) {
  const idx = content.indexOf(str);
  console.log('=== ' + str + ' at ' + idx + ' ===');
  if (idx !== -1) {
    console.log(content.slice(idx, idx + len));
  }
}

find('data-module="v105_18"');
find('id="v18Float"');
find('v18_cur');

