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

  const orders = await queryDelta(kRead, sRead, '/v2/orders/history', 'page_size=20');
  console.log('Orders on Read Key:');
  if (orders.result) {
    orders.result.forEach(o => {
      console.log(`${o.product_symbol || (o.product && o.product.symbol)} | state: ${o.state} | side: ${o.side} | size: ${o.size} | unfilled: ${o.unfilled_size} | avg_fill: ${o.average_fill_price} | created: ${o.created_at}`);
    });
  }

  await pool.end();
}
run();

