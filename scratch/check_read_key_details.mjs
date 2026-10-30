import { Pool } from 'pg';
import dotenv from 'dotenv';
import { open } from './dist/lib/crypto.js';
import { signDelta } from './dist/routes/delta.js';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function queryDelta(key, secret, path, query) {
  const ts = String(Math.floor(Date.now() / 1000));
  const fullQuery = query ? '?' + query : '';
  const sig = signDelta(secret, 'GET', ts, path, fullQuery);
  const res = await fetch('https://api.india.delta.exchange' + path + fullQuery, {
    headers: { 'api-key': key, timestamp: ts, signature: sig, Accept: 'application/json' }
  });
  return res.json();
}

async function run() {
  const saj = (await pool.query("SELECT id FROM users WHERE email = 'saj17111998@gmail.com'")).rows[0];
  const rRead = (await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [saj.id])).rows[0];
  const kRead = open({ data: rRead.key_enc, salt: rRead.key_salt, iv: rRead.key_iv, tag: rRead.key_tag });
  const sRead = open({ data: rRead.secret_enc, salt: rRead.secret_salt, iv: rRead.secret_iv, tag: rRead.secret_tag });

  console.log('Testing fills on read key without filters:');
  const fills1 = await queryDelta(kRead, sRead, '/v2/fills', 'page_size=20');
  console.log('fills (no filter):', fills1.result ? fills1.result.length : fills1);

  console.log('Testing orders/history on read key:');
  const orders = await queryDelta(kRead, sRead, '/v2/orders/history', 'page_size=20');
  console.log('orders history:', orders.result ? orders.result.length : orders);

  console.log('Testing wallet balances on read key:');
  const bal = await queryDelta(kRead, sRead, '/v2/wallet/balances', '');
  console.log('balances:', JSON.stringify(bal.result ? bal.result.map(b => ({ asset: b.asset_symbol, balance: b.balance, available: b.available_balance })) : bal));

  console.log('Testing positions without contract_types on read key:');
  const pos = await queryDelta(kRead, sRead, '/v2/positions/margined', '');
  console.log('positions (no filter):', pos.result ? (Array.isArray(pos.result) ? pos.result.length : pos.result.positions ? pos.result.positions.length : pos) : pos);

  await pool.end();
}
run();

