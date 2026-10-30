import { Pool } from 'pg';
import dotenv from 'dotenv';
import { open } from './dist/lib/crypto.js';
import { signDelta } from './dist/routes/delta.js';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkDeskUser() {
  const rTrade = (await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', ['00000000-0000-0000-0000-000000000001'])).rows[0];
  const kTrade = open({ data: rTrade.key_enc, salt: rTrade.key_salt, iv: rTrade.key_iv, tag: rTrade.key_tag });
  const sTrade = open({ data: rTrade.secret_enc, salt: rTrade.secret_salt, iv: rTrade.secret_iv, tag: rTrade.secret_tag });

  console.log('Desk User Trade Key prefix:', kTrade.slice(0, 8));
  const ts = String(Math.floor(Date.now() / 1000));
  const path = '/v2/positions/margined';
  const query = '?contract_types=call_options,put_options';
  const sig = signDelta(sTrade, 'GET', ts, path, query);
  const res = await fetch('https://api.india.delta.exchange' + path + query, {
    headers: { 'api-key': kTrade, timestamp: ts, signature: sig, Accept: 'application/json' }
  });
  const data = await res.json();
  console.log('Desk User Trade Key positions:', data.result ? data.result.map(p => ({ sym: p.product_symbol || (p.product && p.product.symbol), size: p.size })) : data);

  await pool.end();
}
checkDeskUser();

