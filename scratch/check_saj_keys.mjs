import { Pool } from 'pg';
import dotenv from 'dotenv';
import { open } from './dist/lib/crypto.js';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const u = (await pool.query("SELECT * FROM users WHERE email = 'saj17111998@gmail.com'")).rows[0];
  const rRead = (await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [u.id])).rows[0];
  const rTrade = (await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', [u.id])).rows[0];

  const kRead = rRead ? open({ data: rRead.key_enc, salt: rRead.key_salt, iv: rRead.key_iv, tag: rRead.key_tag }) : null;
  const kTrade = rTrade ? open({ data: rTrade.key_enc, salt: rTrade.key_salt, iv: rTrade.key_iv, tag: rTrade.key_tag }) : null;

  console.log('saj Read Key prefix:', kRead ? kRead.slice(0, 8) : 'none');
  console.log('saj Trade Key prefix:', kTrade ? kTrade.slice(0, 8) : 'none');
  console.log('ENV Key prefix:', process.env.DELTA_API_KEY ? process.env.DELTA_API_KEY.slice(0, 8) : 'none');

  await pool.end();
}
run();

