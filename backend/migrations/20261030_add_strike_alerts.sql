-- Migration: Add strike_alerts table (Task T3.1)
-- Safe to execute idempotently

CREATE TABLE IF NOT EXISTS strike_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid,
  call_strike numeric NOT NULL,
  put_strike numeric NOT NULL,
  confidence_score numeric NOT NULL,
  iv_rank numeric,
  emitted_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_strike_alerts_emitted_at ON strike_alerts(emitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_strike_alerts_cohort_id ON strike_alerts(cohort_id);
