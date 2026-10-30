import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const regex = /pgPnl/g;
let m;
const lines = content.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('pgPnl') && (l.includes('appendChild') || l.includes('innerHTML') || l.includes('querySelector') || l.includes('getElementById'))) {
    console.log((idx+1) + ': ' + l.trim().slice(0, 100));
  }
});

