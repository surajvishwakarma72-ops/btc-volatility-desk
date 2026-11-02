// Print a run-page.mjs JSON result compactly (drops the long inventory list), plus any page exceptions.
const o = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const r = o.result && typeof o.result === 'object' ? { ...o.result } : o.result;
if (r && r.inventory) r.inventory = r.inventory.length + ' entries';
console.log(JSON.stringify(r));
const exc = (o.logs || []).filter(l => /^EXC|arrange|dkHeights|dkSplit/.test(l));
if (exc.length) console.log('logs:', exc.slice(0, 6).join(' | '));
