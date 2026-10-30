const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('const tok = API.tok');
console.log(html.slice(sIdx - 1200, sIdx - 600));

