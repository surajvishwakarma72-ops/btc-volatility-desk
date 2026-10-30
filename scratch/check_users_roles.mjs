import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkUsers() {
  const users = (await pool.query("SELECT id, email, role FROM users")).rows;
  console.log(users);
  await pool.end();
}
checkUsers();

