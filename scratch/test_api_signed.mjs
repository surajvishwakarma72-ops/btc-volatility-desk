import { Pool } from 'pg';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

dotenv.config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function testApi() {
  const u = (await pool.query("SELECT * FROM users WHERE email = 'saj17111998@gmail.com'")).rows[0];
  const token = jwt.sign({ sub: u.id, email: u.email, role: u.role || 'user' }, process.env.JWT_SECRET || 'secret');

  console.log('Testing /api/v1/delta/signed with kind=read...');
  const resRead = await fetch('http://127.0.0.1:4000/api/v1/delta/signed?kind=read&path=/v2/positions/margined&query=contract_types=call_options,put_options', {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log('Status Read:', resRead.status);
  const dataRead = await resRead.json();
  console.log('Data Read:', JSON.stringify(dataRead, null, 2));

  console.log('Testing /api/v1/delta/signed with kind=trade...');
  const resTrade = await fetch('http://127.0.0.1:4000/api/v1/delta/signed?kind=trade&path=/v2/positions/margined&query=contract_types=call_options,put_options', {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log('Status Trade:', resTrade.status);
  const dataTrade = await resTrade.json();
  console.log('Data Trade:', JSON.stringify(dataTrade, null, 2));

  await pool.end();
}
testApi();

