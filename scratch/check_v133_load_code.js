const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('pnl() { render();');
console.log(html.slice(sIdx - 3000, sIdx));

