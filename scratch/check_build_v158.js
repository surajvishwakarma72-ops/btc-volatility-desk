const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function build() {');
const third = html.indexOf('function build() {', html.indexOf('function build() {', sIdx + 10) + 10);
console.log(html.slice(third - 100, third + 1200));

