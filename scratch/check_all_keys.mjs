import { Pool } from 'pg';
import dotenv from 'dotenv';
import { open } from './dist/lib/crypto.js';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const users = (await pool.query("SELECT * FROM users")).rows;
  console.log('--- ALL USERS KEYS ---');
  for (const u of users) {
    const rRead = (await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [u.id])).rows[0];
    const rTrade = (await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', [u.id])).rows[0];
    let kRead = null, kTrade = null;
    try {
      kRead = rRead ? open({ data: rRead.key_enc, salt: rRead.key_salt, iv: rRead.key_iv, tag: rRead.key_tag }) : null;
    } catch (e) { kRead = 'error: ' + e.message; }
    try {
      kTrade = rTrade ? open({ data: rTrade.key_enc, salt: rTrade.key_salt, iv: rTrade.key_iv, tag: rTrade.key_tag }) : null;
    } catch (e) { kTrade = 'error: ' + e.message; }

    console.log(`User: ${u.email} (${u.id})`);
    console.log(`  Read Key: ${kRead ? kRead.slice(0, 8) + '...' : 'none'}`);
    console.log(`  Trade Key: ${kTrade ? kTrade.slice(0, 8) + '...' : 'none'}`);
  }

  await pool.end();
}
run();

