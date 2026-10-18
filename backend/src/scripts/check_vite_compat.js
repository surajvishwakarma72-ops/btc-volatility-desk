import fs from 'node:fs';

const origHtml = fs.readFileSync('../Volatility Desk.html', 'utf8');

const srcScripts = [...origHtml.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
console.log('External script src attributes:', srcScripts);

const moduleScripts = [...origHtml.matchAll(/<script[^>]*type=["']module["'][^>]*>/gi)];
console.log('type=module scripts count:', moduleScripts.length);
