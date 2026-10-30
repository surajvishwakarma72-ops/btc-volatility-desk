const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = 2381618;
console.log(html.slice(sIdx + 400, sIdx + 3000));

