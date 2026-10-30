const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function build() {');
const second = html.indexOf('function build() {', sIdx + 10);
console.log('build functions:');
console.log(html.slice(sIdx - 100, sIdx + 500));
console.log(html.slice(second - 100, second + 500));

