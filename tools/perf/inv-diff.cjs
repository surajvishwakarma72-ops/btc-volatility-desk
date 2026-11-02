// Compare a check result's inventory with the saved "before" inventory.
// usage: node inv-diff.cjs <before.json> <desktop|phone> <run-result.json>
const fs = require('fs');
const before = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[process.argv[3]];
const after = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).result.inventory;
const A = new Set(after), B = new Set(before);
console.log('missing now:', JSON.stringify(before.filter(x => !A.has(x))));
console.log('new now:', JSON.stringify(after.filter(x => !B.has(x))));
