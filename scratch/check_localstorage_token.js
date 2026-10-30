import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const regex = /localStorage\.setItem\(['"]([^'"]*token[^'"]*)['"]/gi;
let m;
while ((m = regex.exec(content)) !== null) {
  console.log(m[0]);
}

