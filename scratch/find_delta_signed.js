const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const regex = /\/api\/v1\/delta\/signed/g;
let m;
while ((m = regex.exec(html)) !== null) {
  console.log('Pos:', m.index);
  console.log(html.slice(Math.max(0, m.index - 80), Math.min(html.length, m.index + 200)));
}

