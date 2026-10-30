const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');

const sIdx = html.indexOf('const tok = API.tok');
if (sIdx > -1) {
  console.log(html.slice(sIdx - 100, sIdx + 400));
} else {
  // search for API.tok
  const idx = html.indexOf('API.tok');
  console.log('API.tok at:', idx);
  console.log(html.slice(idx - 100, idx + 400));
}

