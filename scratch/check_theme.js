import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const regex = /moreTheme|data-theme|setTheme/g;
let m;
while ((m = regex.exec(content)) !== null) {
  const start = Math.max(0, m.index - 50);
  console.log(content.slice(start, start + 120).replace(/\r?\n/g, ' '));
}

