// Syntax-check every inline <script> in an HTML file: compiles each one (never runs it).
// usage: node tools/perf/parse-check.cjs frontend/index.html
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
let m, n = 0, bad = 0;
while ((m = re.exec(html))) {
  n++;
  const attrs = m[1];
  if (/type="(?!text\/javascript|module)[^"]+"/.test(attrs)) continue;
  let code = m[2];
  if (/type="module"/.test(attrs)) code = code.replace(/^\s*(import|export)\b.*$/gm, '');
  try { new Function(code); } catch (e) {
    bad++;
    console.log('PARSE ERROR in script at line', html.slice(0, m.index).split('\n').length, attrs.trim(), '-', e.message);
  }
}
console.log('scripts', n, 'errors', bad);
process.exit(bad ? 1 : 0);
