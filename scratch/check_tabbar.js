import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const lines = content.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('#tabbar') || l.includes('.tabbar')) {
    console.log((idx+1) + ': ' + l.trim());
  }
});

