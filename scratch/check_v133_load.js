const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('W.v133 =');
console.log(html.slice(sIdx - 5000, sIdx - 2000));

