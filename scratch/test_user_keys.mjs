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
  const u = (await pool.query("SELECT * FROM users WHERE email = 'saj17111998@gmail.com'")).rows[0];
  const rRead = (await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [u.id])).rows[0];
  const rTrade = (await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', [u.id])).rows[0];

  const kRead = open({ data: rRead.key_enc, salt: rRead.key_salt, iv: rRead.key_iv, tag: rRead.key_tag });
  const sRead = open({ data: rRead.secret_enc, salt: rRead.secret_salt, iv: rRead.secret_iv, tag: rRead.secret_tag });

  const kTrade = open({ data: rTrade.key_enc, salt: rTrade.key_salt, iv: rTrade.key_iv, tag: rTrade.key_tag });
  const sTrade = open({ data: rTrade.secret_enc, salt: rTrade.secret_salt, iv: rTrade.secret_iv, tag: rTrade.secret_tag });

  console.log('--- 1. Saj READ KEY (' + kRead.slice(0, 8) + ') ---');
  const posRead = await queryDelta(kRead, sRead, '/v2/positions/margined', 'contract_types=call_options,put_options');
  console.log('Positions count:', posRead.result ? (Array.isArray(posRead.result) ? posRead.result.length : posRead.result.positions ? posRead.result.positions.length : 0) : posRead);
  const fillsRead = await queryDelta(kRead, sRead, '/v2/fills', 'contract_types=call_options,put_options&page_size=5');
  console.log('Fills count:', fillsRead.result ? fillsRead.result.length : fillsRead);
  if (fillsRead.result && fillsRead.result[0]) console.log('Latest fill read:', fillsRead.result[0].product_symbol, fillsRead.result[0].created_at);

  console.log('\n--- 2. Saj TRADE KEY (' + kTrade.slice(0, 8) + ') ---');
  const posTrade = await queryDelta(kTrade, sTrade, '/v2/positions/margined', 'contract_types=call_options,put_options');
  console.log('Positions count:', posTrade.result ? (Array.isArray(posTrade.result) ? posTrade.result.length : posTrade.result.positions ? posTrade.result.positions.length : 0) : posTrade);
  if (posTrade.result && Array.isArray(posTrade.result) && posTrade.result.length) {
    console.log('Open pos:', posTrade.result.map(p => ({ sym: p.product_symbol || (p.product && p.product.symbol), size: p.size, uPnl: p.unrealized_pnl })));
  }
  const fillsTrade = await queryDelta(kTrade, sTrade, '/v2/fills', 'contract_types=call_options,put_options&page_size=5');
  console.log('Fills count:', fillsTrade.result ? fillsTrade.result.length : fillsTrade);
  if (fillsTrade.result && fillsTrade.result[0]) console.log('Latest fill trade:', fillsTrade.result[0].product_symbol, fillsTrade.result[0].created_at);

  console.log('\n--- 3. ENV KEY (' + (process.env.DELTA_API_KEY || '').slice(0, 8) + ') ---');
  const posEnv = await queryDelta(process.env.DELTA_API_KEY, process.env.DELTA_API_SECRET, '/v2/positions/margined', 'contract_types=call_options,put_options');
  console.log('Positions count:', posEnv.result ? (Array.isArray(posEnv.result) ? posEnv.result.length : posEnv.result.positions ? posEnv.result.positions.length : 0) : posEnv);
  if (posEnv.result && Array.isArray(posEnv.result) && posEnv.result.length) {
    console.log('Open pos:', posEnv.result.map(p => ({ sym: p.product_symbol || (p.product && p.product.symbol), size: p.size, uPnl: p.unrealized_pnl })));
  }

  await pool.end();
}
run();

