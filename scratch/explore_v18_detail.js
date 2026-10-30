const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

const idx = content.indexOf('data-module="v105_18"');
console.log(content.slice(idx + 1000, idx + 4500));

