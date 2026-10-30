const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const regex = /data-page=["']pgPnl["']/g;
let m;
while ((m = regex.exec(html)) !== null) {
  console.log(m.index, html.slice(Math.max(0, m.index - 50), Math.min(html.length, m.index + 100)).replace(/\n/g, ' '));
}

