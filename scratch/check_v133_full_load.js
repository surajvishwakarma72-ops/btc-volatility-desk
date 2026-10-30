const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('v133 = {');
console.log(html.slice(sIdx - 3000, sIdx));

