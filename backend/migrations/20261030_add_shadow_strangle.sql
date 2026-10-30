-- Migration: Add shadow_strangles table for hourly virtual cohorts (Task T2.5)
-- Safe to execute idempotently

CREATE TABLE IF NOT EXISTS shadow_strangles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_hour timestamptz NOT NULL,
  call_strike numeric NOT NULL,
  put_strike numeric NOT NULL,
  call_entry_iv numeric NOT NULL,
  put_entry_iv numeric NOT NULL,
  call_delta numeric NOT NULL,
  put_delta numeric NOT NULL,
  spot_at_entry numeric NOT NULL,
  confidence_score numeric NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'open',
  closed_at timestamptz,
  pnl_usd numeric,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_cohort ON shadow_strangles(cohort_hour DESC);
