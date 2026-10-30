import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const lines = content.split('\n');
console.log(lines.slice(64920, 64980).join('\n'));

