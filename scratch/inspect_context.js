const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const lines = html.split('\n');
console.log('L46470-46480:');
for (let i = 46468; i < 46480; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}

console.log('\nL51210-51225:');
for (let i = 51208; i < 51225; i++) {
  console.log(`${i+1}: ${lines[i]}`);
}

