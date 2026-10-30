-- Migration: Add iv_history table (Task T4.1)
-- Safe to execute idempotently

CREATE TABLE IF NOT EXISTS iv_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expiry_label varchar(50) NOT NULL,
  mark_vol decimal NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_iv_history_expiry ON iv_history(expiry_label, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_iv_history_recorded_at ON iv_history(recorded_at DESC);
