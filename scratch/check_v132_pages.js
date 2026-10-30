const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const matches = [...html.matchAll(/(v132-pages|#pgDesk)/g)];
matches.slice(0, 30).forEach(m => console.log(m.index, m[0], html.slice(Math.max(0, m.index - 40), Math.min(html.length, m.index + 100)).replace(/\n/g, ' ')));

