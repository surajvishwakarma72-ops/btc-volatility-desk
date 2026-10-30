const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

// Find all places where moreTab or moreSheet are bound
const lines = html.split('\n');
lines.forEach((l, i) => {
  if (l.includes('moreTab') || l.includes('moreSheet')) {
    console.log(`${i+1}: ${l.slice(0, 160)}`);
  }
});

