const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = 2724516;
console.log(html.slice(sIdx - 500, sIdx + 500));

