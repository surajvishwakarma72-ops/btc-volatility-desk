import fs from 'fs';

const content = fs.readFileSync('scratch/update_final_pnl.js', 'utf8');
const lines = content.split('\n');
lines.forEach((l, idx) => {
  if (l.includes("addEventListener('click'") || l.includes('addEventListener("click"')) {
    console.log((idx+1) + ': ' + l.trim());
  }
});

