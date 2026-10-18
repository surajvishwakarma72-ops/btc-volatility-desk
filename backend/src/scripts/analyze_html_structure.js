import fs from 'node:fs';

const html = fs.readFileSync('../Volatility Desk.html', 'utf8');
const lines = html.split('\n');
console.log('Total lines:', lines.length);

let inScript = false;
let scriptCount = 0;
let styleCount = 0;
let htmlLineCount = 0;
let scripts = [];
let styles = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('<style')) {
    const id = line.match(/id=["']?([^"'>\s]+)/)?.[1] || `style_${styleCount}`;
    styles.push({ id, line: i + 1 });
    styleCount++;
  }
  if (line.includes('<script')) {
    const id = line.match(/id=["']?([^"'>\s]+)/)?.[1] || line.match(/data-module=["']?([^"'>\s]+)/)?.[1] || `script_${scriptCount}`;
    const src = line.match(/src=["']?([^"'>\s]+)/)?.[1];
    scripts.push({ id, src, line: i + 1 });
    scriptCount++;
  }
}

console.log('Styles found:', styles.length);
console.log('First 5 styles:', styles.slice(0, 5));
console.log('Scripts found:', scripts.length);
console.log('First 10 scripts:', scripts.slice(0, 10));
console.log('Last 10 scripts:', scripts.slice(-10));

// Find where <body> starts and where the first script starts
const bodyIndex = lines.findIndex(l => l.includes('<body'));
const firstScriptIndex = lines.findIndex((l, idx) => idx > bodyIndex && l.includes('<script'));
console.log('Body starts at line:', bodyIndex + 1);
console.log('First script in body starts at line:', firstScriptIndex + 1);
