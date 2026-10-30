import { Pool } from 'pg';
import dotenv from 'dotenv';
import { open } from './dist/lib/crypto.js';
import { signDelta } from './dist/routes/delta.js';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkPos() {
  const u = (await pool.query("SELECT * FROM users WHERE email = 'saj17111998@gmail.com'")).rows[0];
  
  // Read Key
  const rRead = (await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [u.id])).rows[0];
  if (rRead) {
    const k = open({ data: rRead.key_enc, salt: rRead.key_salt, iv: rRead.key_iv, tag: rRead.key_tag });
    const s = open({ data: rRead.secret_enc, salt: rRead.secret_salt, iv: rRead.secret_iv, tag: rRead.secret_tag });
    const ts = String(Math.floor(Date.now() / 1000));
    const path = '/v2/positions/margined';
    const query = '?contract_types=call_options,put_options';
    const sig = signDelta(s, 'GET', ts, path, query);
    const res = await fetch('https://api.india.delta.exchange' + path + query, {
      headers: { 'api-key': k, timestamp: ts, signature: sig, Accept: 'application/json' }
    });
    const data = await res.json();
    console.log('READ Open positions count:', data.result ? (Array.isArray(data.result) ? data.result.length : (data.result.positions ? data.result.positions.length : data)) : data);
  }

  // Trade Key
  const rTrade = (await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', [u.id])).rows[0];
  if (rTrade) {
    const k = open({ data: rTrade.key_enc, salt: rTrade.key_salt, iv: rTrade.key_iv, tag: rTrade.key_tag });
    const s = open({ data: rTrade.secret_enc, salt: rTrade.secret_salt, iv: rTrade.secret_iv, tag: rTrade.secret_tag });
    const ts = String(Math.floor(Date.now() / 1000));
    const path = '/v2/positions/margined';
    const query = '?contract_types=call_options,put_options';
    const sig = signDelta(s, 'GET', ts, path, query);
    const res = await fetch('https://api.india.delta.exchange' + path + query, {
      headers: { 'api-key': k, timestamp: ts, signature: sig, Accept: 'application/json' }
    });
    const data = await res.json();
    console.log('TRADE Open positions count:', data.result ? (Array.isArray(data.result) ? data.result.length : (data.result.positions ? data.result.positions.length : data)) : data);
  }

  await pool.end();
}
checkPos();
