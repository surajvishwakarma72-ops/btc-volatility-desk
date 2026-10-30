const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('const by = new Map(); for (const c of C.values())');
console.log(html.slice(sIdx - 3000, sIdx));

