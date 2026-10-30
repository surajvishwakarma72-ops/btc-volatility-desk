import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const idx = content.indexOf('id="pgPnl"');
console.log('Found pgPnl at', idx);
console.log(content.slice(idx - 30, idx + 1200));

