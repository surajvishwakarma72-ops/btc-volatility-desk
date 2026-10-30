const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

// Find all places where click events are added to window, document, or buttons
const lines = html.split('\n');
lines.forEach((l, i) => {
  if (l.includes('addEventListener') && (l.includes('click') || l.includes('pointer'))) {
    if (l.includes('document') || l.includes('window') || l.includes('tabbar') || l.includes('nav') || l.includes('show(') || l.includes('go(') || l.includes('D.add')) {
      console.log(`${i+1}: ${l.slice(0, 150)}`);
    }
  }
});

