const fs = require('fs');
const c = fs.readFileSync('backend/src/routes/delta.ts', 'utf8');

const sIdx = c.indexOf('fastify.get(\'/signed\'');
console.log(c.slice(sIdx - 100, sIdx + 1200));

