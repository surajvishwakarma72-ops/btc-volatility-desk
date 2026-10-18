import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/dist/index.html'), 'utf8');

const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;
let errors = 0;

while ((match = scriptRegex.exec(html)) !== null) {
  count++;
  const attrs = match[1];
  const code = match[2].trim();
  if (!code) {
    console.log(`[Script #${count}] External script: <script ${attrs}>`);
    continue;
  }
  if (attrs.includes('type="module"')) {
    console.log(`[Script #${count}] Module script (skipping new Function test): <script ${attrs}>`);
    continue;
  }
  try {
    new Function(code);
  } catch (e) {
    errors++;
    console.error(`[Script #${count}] Syntax error:`, e.message, `Attr: <script ${attrs}>`);
  }
}

console.log(`\nTotal scripts: ${count}. Syntax errors: ${errors}.`);
