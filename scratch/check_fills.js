let Pool, dotenv;
try {
  Pool = require('pg').Pool;
  dotenv = require('dotenv');
} catch (e) {
  Pool = require('../backend/node_modules/pg').Pool;
  dotenv = require('../backend/node_modules/dotenv');
}
dotenv.config({ path: 'backend/.env' });
const { open } = require('./backend/dist/lib/crypto.js');
const { signDelta } = require('./backend/dist/routes/delta.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function queryFills(apiKey, apiSecret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const path = '/v2/fills';
  const query = '?page_size=50';
  const sig = signDelta(apiSecret, 'GET', ts, path, query);
  const res = await fetch('https://api.india.delta.exchange' + path + query, {
    headers: { 'api-key': apiKey, timestamp: ts, signature: sig, Accept: 'application/json' }
  });
  return res.json();
}

async function test() {
  const users = await pool.query('SELECT id, email FROM users');
  for (const u of users.rows) {
    console.log('=== USER:', u.email, u.id);
    const rRead = await pool.query('SELECT * FROM desk_delta_keys WHERE user_id = $1', [u.id]);
    if (rRead.rows[0]) {
      const x = rRead.rows[0];
      try {
        const k = open({ data: x.key_enc, salt: x.key_salt, iv: x.key_iv, tag: x.key_tag });
        const s = open({ data: x.secret_enc, salt: x.secret_salt, iv: x.secret_iv, tag: x.secret_tag });
        console.log('  READ KEY last4:', k.slice(-4));
        const fills = await queryFills(k, s);
        console.log('  READ FILLS count:', fills.result ? fills.result.length : JSON.stringify(fills));
        if (fills.result && fills.result.length > 0) {
          console.log('  READ Latest 3 fills:', JSON.stringify(fills.result.slice(0, 3).map(f => ({
            created_at: f.created_at,
            symbol: f.product_symbol || f.symbol,
            side: f.side,
            size: f.size,
            price: f.price,
            cashflow: f.cashflow,
            fee: f.fee
          })), null, 2));
        }
      } catch (e) { console.log('  READ err:', e.message); }
    }
    const rTrade = await pool.query('SELECT * FROM desk_delta_trade_keys WHERE user_id = $1', [u.id]);
    if (rTrade.rows[0]) {
      const x = rTrade.rows[0];
      try {
        const k = open({ data: x.key_enc, salt: x.key_salt, iv: x.key_iv, tag: x.key_tag });
        const s = open({ data: x.secret_enc, salt: x.secret_salt, iv: x.secret_iv, tag: x.secret_tag });
        console.log('  TRADE KEY last4:', k.slice(-4));
        const fills = await queryFills(k, s);
        console.log('  TRADE FILLS count:', fills.result ? fills.result.length : JSON.stringify(fills));
        if (fills.result && fills.result.length > 0) {
          console.log('  TRADE Latest 3 fills:', JSON.stringify(fills.result.slice(0, 3).map(f => ({
            created_at: f.created_at,
            symbol: f.product_symbol || f.symbol,
            side: f.side,
            size: f.size,
            price: f.price,
            cashflow: f.cashflow,
            fee: f.fee
          })), null, 2));
        }
      } catch (e) { console.log('  TRADE err:', e.message); }
    }
  }
  await pool.end();
}
test().catch(console.error);
