import { pool } from './dist/db/index.js';
import { loadDeltaKey } from './dist/services/delta-keys.js';
import { deltaSignedGet } from './dist/routes/delta.js';

async function test() {
  const users = await pool.query('SELECT id, email, role FROM users');
  console.log('Users in users table:', users.rows);

  const targetUid = '1420e307-b827-4339-8210-a0eecd848ae1';

  const readCreds = await loadDeltaKey(targetUid, 'read');
  console.log('\n--- READ KEY fills (first 10) ---');
  if (readCreds) {
    const f = await deltaSignedGet(readCreds.key, readCreds.secret, '/v2/fills', 'contract_types=call_options,put_options&page_size=50');
    console.log('Read fills count:', f.body?.result?.length);
    console.log(f.body?.result?.slice(0, 10).map(x => ({
      id: x.id,
      side: x.side,
      sym: x.product_symbol,
      size: x.size,
      price: x.price,
      created: x.created_at,
      pnl: x.meta_data?.new_position?.realized_pnl,
      cashflow: x.meta_data?.new_position?.realized_cashflow
    })));
  }

  const tradeCreds = await loadDeltaKey(targetUid, 'trade');
  console.log('\n--- TRADE KEY fills ---');
  if (tradeCreds) {
    const f = await deltaSignedGet(tradeCreds.key, tradeCreds.secret, '/v2/fills', 'contract_types=call_options,put_options&page_size=50');
    console.log('Trade fills count:', f.body?.result?.length);
    console.log(f.body?.result?.map(x => ({
      id: x.id,
      side: x.side,
      sym: x.product_symbol,
      size: x.size,
      price: x.price,
      created: x.created_at,
      pnl: x.meta_data?.new_position?.realized_pnl,
      cashflow: x.meta_data?.new_position?.realized_cashflow
    })));

    const pos = await deltaSignedGet(tradeCreds.key, tradeCreds.secret, '/v2/positions/margined', 'contract_types=call_options,put_options');
    console.log('Trade positions:', JSON.stringify(pos.body));
  }
}
test().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
