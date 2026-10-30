const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

const idx = content.indexOf('data-module="v105_18"');
console.log(content.slice(idx + 8000, idx + 12000));

