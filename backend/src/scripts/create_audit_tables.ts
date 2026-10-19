import 'dotenv/config';
import { pool } from '../db/index.js';

async function main() {
  console.log('Creating session_audit_logs and recalibration_audits tables...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_date DATE NOT NULL,
      day_of_week INTEGER NOT NULL,
      day_name VARCHAR(10) NOT NULL,
      session_status VARCHAR(20) NOT NULL,
      entry_time TIMESTAMPTZ,
      exit_time TIMESTAMPTZ,
      call_strike NUMERIC(12, 2),
      put_strike NUMERIC(12, 2),
      call_delta NUMERIC(6, 4),
      put_delta NUMERIC(6, 4),
      call_entry_premium NUMERIC(12, 2),
      put_entry_premium NUMERIC(12, 2),
      call_exit_premium NUMERIC(12, 2),
      put_exit_premium NUMERIC(12, 2),
      speed_vs_iv NUMERIC(6, 3),
      sizing NUMERIC(4, 2) NOT NULL DEFAULT 0,
      realized_pnl NUMERIC(12, 2),
      outcome VARCHAR(20) NOT NULL DEFAULT 'SKIPPED',
      ui_state JSONB NOT NULL,
      rule_state JSONB NOT NULL,
      telemetry_match BOOLEAN NOT NULL DEFAULT true,
      mismatch_reason TEXT,
      meta JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recalibration_audits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_sessions INTEGER NOT NULL,
      in_sample_sessions INTEGER NOT NULL,
      out_of_sample_sessions INTEGER NOT NULL,
      bonferroni_alpha NUMERIC(8, 6) NOT NULL,
      tue_wed_stop_rate NUMERIC(6, 2),
      speed_stop_rate NUMERIC(6, 2),
      combo_stop_rate NUMERIC(6, 2),
      combo_p_value NUMERIC(8, 6),
      cleared_bonferroni BOOLEAN NOT NULL,
      oos_stop_rate NUMERIC(6, 2),
      oos_stability_verdict VARCHAR(30) NOT NULL,
      audit_summary JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS session_audit_logs_user_date_idx ON session_audit_logs(user_id, session_date);
  `);

  console.log('Tables created successfully.');
  await pool.end();
}

main().catch((err) => {
  console.error('Error creating audit tables:', err);
  process.exit(1);
});
