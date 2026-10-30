const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = 2724516;
console.log(html.slice(sIdx - 1500, sIdx - 500));

