const fs = require('fs');

const content = fs.readFileSync('frontend/index.html', 'utf8');

const idx = content.indexOf('data-module="v100"');
const end = content.indexOf('</script>', idx);

const block = content.slice(idx, end);
console.log('v100 block length:', block.length);

// search for delta-proxy, fetch, or api
const lines = block.split('\n');
lines.forEach((l, i) => {
  if (l.includes('delta-proxy') || l.includes('/api/v1/delta') || l.includes('v100.api') || l.includes('positions/margined')) {
    console.log(i, l);
  }
});

