import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const regex = /localStorage\.setItem\(([^)]+)\)/g;
let m;
const keys = new Set();
while ((m = regex.exec(content)) !== null) {
  keys.add(m[1].split(',')[0].trim());
}
console.log('localStorage keys set:');
console.log(Array.from(keys));

