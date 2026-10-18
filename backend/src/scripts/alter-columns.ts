import 'dotenv/config';
import { pool } from '../db/index.js';

async function main() {
  const client = await pool.connect();
  try {
    console.log('Altering column precision on indicator_snapshots...');
    await client.query(`
      ALTER TABLE indicator_snapshots ALTER COLUMN skew_25d TYPE numeric(20, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN term_current_n2n TYPE numeric(16, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN term_next_n2n TYPE numeric(16, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN forward_vol TYPE numeric(16, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN n2n_iv TYPE numeric(16, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN butterfly TYPE numeric(16, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN atm_iv TYPE numeric(16, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN funding_rate TYPE numeric(12, 6);
      ALTER TABLE indicator_snapshots ALTER COLUMN open_interest TYPE numeric(20, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN liquidation_longs_usd TYPE numeric(20, 4);
      ALTER TABLE indicator_snapshots ALTER COLUMN liquidation_shorts_usd TYPE numeric(20, 4);
    `);
    console.log('Successfully widened indicator_snapshots column precisions in Neon PostgreSQL!');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error altering table:', err);
  process.exit(1);
});
