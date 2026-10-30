import fs from 'fs';

const content = fs.readFileSync('frontend/index.html', 'utf8');
const pnlMatch = content.match(/<section class="page" id="pgPnl"[^>]*>([\s\S]*?)<\/section>/);
if (pnlMatch) {
  console.log('Inside #pgPnl:');
  console.log(pnlMatch[1].slice(0, 1000));
} else {
  console.log('No static content inside #pgPnl');
}

