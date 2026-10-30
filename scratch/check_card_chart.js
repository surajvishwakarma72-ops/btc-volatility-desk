const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('const Wd = 880, Ht = 180;');
console.log(html.slice(sIdx - 100, sIdx + 1500));

