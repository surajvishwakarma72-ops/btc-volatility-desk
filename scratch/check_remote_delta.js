const { execSync } = require('child_process');
const keyPath = 'C:\\Users\\suraj\\.ssh\\oracle_key';

// Query Postgres directly or call delta signed endpoint via curl on server with the user token or env key
const script = `
sudo docker compose -f ~/app/docker-compose.prod.yml exec -T app node -e "
const { pool } = require('./dist/db/index.js');
const { loadDeltaKey } = require('./dist/services/delta-keys.js');
const { deltaSignedGet } = require('./dist/routes/delta.js');

async function test() {
  const users = await pool.query('SELECT user_id, email FROM desk_users');
  console.log('Users in DB:', users.rows);

  const keys = await pool.query('SELECT user_id, key_last4 FROM desk_delta_keys');
  console.log('Read keys in DB:', keys.rows);

  const tradeKeys = await pool.query('SELECT user_id, key_last4 FROM desk_delta_trade_keys');
  console.log('Trade keys in DB:', tradeKeys.rows);

  // If there is a key, test fetching fills and positions!
  for (const k of keys.rows) {
    const creds = await loadDeltaKey(k.user_id, 'read');
    if (creds) {
      console.log('Testing read key for user:', k.user_id, 'last4:', creds.key.slice(-4));
      const pos = await deltaSignedGet(creds.key, creds.secret, '/v2/positions/margined', 'contract_types=call_options,put_options');
      console.log('POS RESULT:', pos.ok, pos.status, JSON.stringify(pos.body).slice(0, 300));
      const fills = await deltaSignedGet(creds.key, creds.secret, '/v2/fills', 'contract_types=call_options,put_options&page_size=50');
      console.log('FILLS RESULT:', fills.ok, fills.status, JSON.stringify(fills.body).slice(0, 300));
    }
  }

  for (const k of tradeKeys.rows) {
    const creds = await loadDeltaKey(k.user_id, 'trade');
    if (creds) {
      console.log('Testing trade key for user:', k.user_id, 'last4:', creds.key.slice(-4));
      const pos = await deltaSignedGet(creds.key, creds.secret, '/v2/positions/margined', 'contract_types=call_options,put_options');
      console.log('TRADE POS RESULT:', pos.ok, pos.status, JSON.stringify(pos.body).slice(0, 300));
      const fills = await deltaSignedGet(creds.key, creds.secret, '/v2/fills', 'contract_types=call_options,put_options&page_size=50');
      console.log('TRADE FILLS RESULT:', fills.ok, fills.status, JSON.stringify(fills.body).slice(0, 300));
    }
  }

  // Also check if process.env.DELTA_API_KEY exists
  if (process.env.DELTA_API_KEY) {
    console.log('ENV DELTA_API_KEY last4:', process.env.DELTA_API_KEY.slice(-4));
    const fills = await deltaSignedGet(process.env.DELTA_API_KEY, process.env.DELTA_API_SECRET, '/v2/fills', 'contract_types=call_options,put_options&page_size=50');
    console.log('ENV FILLS RESULT:', fills.ok, fills.status, JSON.stringify(fills.body).slice(0, 300));
  }
}
test().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
"
`;

try {
  const out = execSync(`ssh -i "${keyPath}" -o StrictHostKeyChecking=no ubuntu@92.4.74.5 "${script.replace(/\n/g, ' ')}"`).toString();
  console.log(out);
} catch (e) {
  console.error(e.message);
  if (e.stdout) console.log('STDOUT:', e.stdout.toString());
  if (e.stderr) console.log('STDERR:', e.stderr.toString());
}

