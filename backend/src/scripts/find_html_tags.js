import fs from 'node:fs';

const html = fs.readFileSync('../Volatility Desk.html', 'utf8');
const lines = html.split('\n');

let htmlBlocks = [];
let insideScript = false;
let insideStyle = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('<script')) insideScript = true;
  if (line.includes('<style')) insideStyle = true;

  if (!insideScript && !insideStyle) {
    if (line.trim().startsWith('<') && !line.trim().startsWith('<!--')) {
      htmlBlocks.push({ lineNum: i + 1, content: line.trim() });
    }
  }

  if (line.includes('</script>')) insideScript = false;
  if (line.includes('</style>')) insideStyle = false;
}

console.log('Total non-script, non-style HTML lines:', htmlBlocks.length);
console.log('Sample HTML tags:');
console.log(htmlBlocks.slice(0, 35));
