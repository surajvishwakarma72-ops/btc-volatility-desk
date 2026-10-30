import fs from 'fs';
const content = fs.readFileSync('scratch/update_final_pnl.js', 'utf8');
const lines = content.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('MutationObserver') || l.includes('setInterval') || l.includes('observe(') || l.includes('drawPanel') || l.includes('subtree')) {
    console.log((idx+1) + ': ' + l.trim().slice(0, 110));
  }
});

