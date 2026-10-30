import fs from 'fs';

const content = fs.readFileSync('scratch/apply_accurate_pnl_and_floating.js', 'utf8');
const lines = content.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('renderCurveSvg') || l.includes('hairline') || l.includes('crosshair') || l.includes('mousemove')) {
    console.log((idx+1) + ': ' + l.slice(0, 100));
  }
});

