const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('function draw() {');
const second = html.indexOf('function draw() {', sIdx + 10);
const third = html.indexOf('function draw() {', second + 10);
console.log(html.slice(second - 200, second + 800));

