import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const users = (await pool.query("SELECT * FROM users")).rows;
  console.log('Users in DB:', users.map(u => ({ id: u.id, email: u.email })));

  const readKeys = (await pool.query("SELECT user_id, updated_at FROM desk_delta_keys")).rows;
  console.log('desk_delta_keys:', readKeys);

  const tradeKeys = (await pool.query("SELECT user_id, updated_at FROM desk_delta_trade_keys")).rows;
  console.log('desk_delta_trade_keys:', tradeKeys);

  console.log('ENV DELTA_API_KEY present:', !!process.env.DELTA_API_KEY, process.env.DELTA_API_KEY ? process.env.DELTA_API_KEY.slice(0, 6) : 'none');

  await pool.end();
}
run();

