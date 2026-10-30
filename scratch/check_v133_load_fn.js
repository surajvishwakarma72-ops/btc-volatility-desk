const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('async function load(');
if (sIdx > -1) {
  console.log(html.slice(sIdx, sIdx + 1500));
} else {
  const matches = [...html.matchAll(/function load\(/g)];
  matches.forEach(m => {
    console.log(html.slice(m.index - 50, m.index + 500));
  });
}

