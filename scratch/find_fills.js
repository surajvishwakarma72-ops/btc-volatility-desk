const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const occurrences = [...html.matchAll(/\/v2\/fills/g)];
console.log('Count of /v2/fills:', occurrences.length);
occurrences.forEach(o => {
  console.log('Pos:', o.index);
  console.log(html.slice(Math.max(0, o.index - 100), Math.min(html.length, o.index + 400)));
});

