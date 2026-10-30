const fs = require('fs');
const content = fs.readFileSync('Volatility Desk.html', 'utf8');

const sIdx = content.indexOf('moreTab');
console.log('moreTab index in Volatility Desk.html:', sIdx);
if (sIdx > -1) {
  const matches = [...content.matchAll(/moreTab/g)];
  matches.forEach(m => {
    console.log(content.slice(Math.max(0, m.index - 50), Math.min(content.length, m.index + 100)).replace(/\n/g, ' '));
  });
}

