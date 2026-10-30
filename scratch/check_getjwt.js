import fs from 'fs';

const content = fs.readFileSync('scratch/apply_accurate_pnl_and_floating.js', 'utf8');
const lines = content.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('getJwt')) {
    console.log(lines.slice(idx, idx + 15).join('\n'));
  }
});

