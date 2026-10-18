import fs from 'node:fs';

const html = fs.readFileSync('../Volatility Desk.html', 'utf8');

// Find style tags
const styleMatches = [...html.matchAll(/<style[^>]*id=["']?([^"'>\s]+)["']?[^>]*>/gi)].map(m => m[1]);
console.log('Style tag IDs:', styleMatches);

// Find body tag
const bodyMatch = html.match(/<body[^>]*>/i);
console.log('Body tag:', bodyMatch ? bodyMatch[0] : 'not found');

// Find major structural divs
const idMatches = [...html.matchAll(/<div[^>]*id=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
console.log('Total div IDs:', idMatches.length);
console.log('Sample div IDs:', idMatches.slice(0, 30));

// Find script tags
const scriptModules = [...html.matchAll(/<script[^>]*data-module=["']([^"']+)["'][^>]*>/gi)].map(m => m[1]);
console.log('Script modules:', scriptModules);

// Find titles or headers
const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
console.log('Title:', titleMatch ? titleMatch[1] : 'not found');
