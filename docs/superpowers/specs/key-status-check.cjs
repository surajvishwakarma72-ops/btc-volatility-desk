// Read-only: prints key health, fill counts and which Delta setting names exist. Selects no key or secret columns, and prints no values of settings.
require('net').setDefaultAutoSelectFamilyAttemptTimeout(10000);
const { Pool } = require('pg');
(async () => {
  console.log('env set:', ['DELTA_API_KEY', 'DELTA_API_SECRET', 'LIVE_TRADING_ENABLED'].filter((k) => process.env[k]));
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const q = async (name, sql) => { try { console.log(name, JSON.stringify((await p.query(sql)).rows)); } catch (e) { console.log(name, 'ERR', e.message); } };
  await q('read keys', 'select key_last4, updated_at, last_ok_at, left(last_error,120) last_error from desk_delta_keys');
  await q('trade keys', 'select key_last4, updated_at, last_ok_at, left(last_error,120) last_error from desk_delta_trade_keys');
  await q('fills', 'select account_kind, count(*), max(filled_at) from fills group by 1');
  await q('real runs', 'select account, status, count(*), max(entered_at) from real_runs group by 1,2');
  await p.end();
})().catch((e) => console.log('failed:', e.message));
