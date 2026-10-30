const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('analyse(');
const occurrences = [...html.matchAll(/analyse\(/g)];
occurrences.forEach(o => {
  console.log(o.index, html.slice(o.index - 50, o.index + 100));
});

