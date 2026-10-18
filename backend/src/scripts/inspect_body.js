import fs from 'node:fs';

const html = fs.readFileSync('../Volatility Desk.html', 'utf8');

// Find all HTML elements directly inside body before scripts
const bodyStart = html.indexOf('<body');
const bodyEnd = html.indexOf('</body>');
const bodyContent = html.slice(bodyStart, bodyEnd > 0 ? bodyEnd : undefined);

console.log('Body tag slice (first 500 chars):');
console.log(bodyContent.slice(0, 500));

// Find major sections / divs directly under body
const topDivs = [...bodyContent.matchAll(/<div[^>]*id=["']([^"']+)["'][^>]*class=["']([^"']+)["']/gi)]
  .map(m => ({ id: m[1], class: m[2] }));

console.log('Top divs with ID & class:', topDivs.slice(0, 25));
