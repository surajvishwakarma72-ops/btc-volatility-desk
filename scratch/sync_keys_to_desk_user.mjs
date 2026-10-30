import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function syncKeys() {
  const saj = (await pool.query("SELECT id FROM users WHERE email = 'saj17111998@gmail.com'")).rows[0];
  const rRead = (await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [saj.id])).rows[0];

  if (rRead) {
    console.log('rRead keys:', Object.keys(rRead));
    await pool.query(`
      INSERT INTO desk_delta_keys (user_id, key_enc, key_salt, key_iv, key_tag, secret_enc, secret_salt, secret_iv, secret_tag, key_last4, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (user_id) DO UPDATE SET
        key_enc = $2, key_salt = $3, key_iv = $4, key_tag = $5,
        secret_enc = $6, secret_salt = $7, secret_iv = $8, secret_tag = $9,
        key_last4 = $10, updated_at = now()
    `, [
      '00000000-0000-0000-0000-000000000001',
      rRead.key_enc, rRead.key_salt, rRead.key_iv, rRead.key_tag,
      rRead.secret_enc, rRead.secret_salt, rRead.secret_iv, rRead.secret_tag,
      rRead.key_last4 || 'skJF'
    ]);
    console.log('Successfully synced read key to DESK_USER_ID!');
  }

  await pool.end();
}
syncKeys();
