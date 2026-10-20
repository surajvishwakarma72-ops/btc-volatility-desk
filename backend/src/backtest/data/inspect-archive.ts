import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_PATH = path.resolve(__dirname, '../../../browser-data-export.json');

const bundle = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf-8'));
const stores = bundle?.indexedDB?.suraj_archive_v1?.stores || {};
const iv: any[] = stores.iv || [];

// Analyze c-field resolution + value scale across records.
let analyzed = 0;
for (const item of iv) {
  const v = item.value || item;
  if (!v?.c || typeof v.c !== 'object') continue;
  const keys = Object.keys(v.c).map(Number).filter((n) => Number.isFinite(n));
  const nonNull = Object.entries(v.c).filter(([, val]) => val != null) as [string, number][];
  if (nonNull.length < 10) continue; // find a populated one
  const maxKey = Math.max(...keys);
  const vals = nonNull.map(([, x]) => Number(x));
  const sample = nonNull.slice(Math.floor(nonNull.length / 2), Math.floor(nonNull.length / 2) + 5);
  console.log(`--- ${item.key} (e=${v.e} day=${v.day}) ---`);
  console.log(`  c total keys: ${keys.length}, maxKey: ${maxKey}, nonNull: ${nonNull.length}`);
  console.log(`  value range: ${Math.min(...vals).toFixed(3)} .. ${Math.max(...vals).toFixed(3)}`);
  console.log(`  mid samples (idx:val): ${sample.map(([k, x]) => `${k}:${x}`).join('  ')}`);
  analyzed++;
  if (analyzed >= 4) break;
}

// Also inspect the other stores we'll need later.
console.log('\n=== other stores (record counts + sample keys) ===');
for (const name of ['flow', 'days', 'events']) {
  const s: any[] = stores[name] || [];
  console.log(`${name}: ${s.length} records; sample[0] keys: ${s[0] ? Object.keys(s[0].value || s[0]).join(',') : 'n/a'}`);
}
const ind: any[] = bundle?.indexedDB?.suraj_ind_v1?.stores?.rows || [];
console.log(`suraj_ind_v1.rows: ${ind.length}; sample keys: ${ind[0] ? Object.keys(ind[0].value || ind[0]).join(',') : 'n/a'}`);
const v5 = bundle?.indexedDB?.btc_iv_rv_terminal_v5?.stores || {};
console.log(`terminal_v5 stores: ${Object.keys(v5).join(',')}`);
