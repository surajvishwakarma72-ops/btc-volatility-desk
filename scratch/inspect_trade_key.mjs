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
  const rTrade = (await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', [saj.id])).rows[0];
  const kTrade = open({ data: rTrade.key_enc, salt: rTrade.key_salt, iv: rTrade.key_iv, tag: rTrade.key_tag });
  const sTrade = open({ data: rTrade.secret_enc, salt: rTrade.secret_salt, iv: rTrade.secret_iv, tag: rTrade.secret_tag });

  const fills = await queryDelta(kTrade, sTrade, '/v2/fills', 'page_size=20');
  console.log('Trade key fills:');
  fills.result.forEach(f => {
    console.log(`${f.product_symbol} | ${f.side} | size: ${f.size} | price: ${f.price} | time: ${f.created_at}`);
  });

  const pos = await queryDelta(kTrade, sTrade, '/v2/positions/margined', 'contract_types=call_options,put_options');
  console.log('Trade key open positions:');
  pos.result.forEach(p => {
    console.log(`${p.product_symbol || (p.product && p.product.symbol)} | size: ${p.size} | entry: ${p.entry_price} | mark: ${p.mark_price} | uPnl: ${p.unrealized_pnl}`);
  });

  await pool.end();
}
run();

