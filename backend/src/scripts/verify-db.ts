import 'dotenv/config';
import { db, pool } from '../db/index.js';
import { sql } from 'drizzle-orm';

async function verify() {
  const tables = [
    'users',
    'trades',
    'trade_legs',
    'nightly_reviews',
    'chart_drawings',
    'user_preferences',
    'alert_rules',
    'alert_logs',
    'indicator_snapshots',
    'market_timeseries',
    'option_flow_buckets',
  ];

  console.log('='.repeat(50));
  console.log('  NEON POSTGRESQL TABLE RECORD VERIFICATION');
  console.log('='.repeat(50));

  for (const t of tables) {
    const res: any = await db.execute(sql.raw(`SELECT count(*) AS count FROM "${t}"`));
    const cnt = res.rows?.[0]?.count ?? res[0]?.count ?? 0;
    console.log(`${t.padEnd(25)} : ${cnt} rows`);
  }
  console.log('='.repeat(50));
}

verify()
  .catch((e) => {
    console.error('Verification error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
