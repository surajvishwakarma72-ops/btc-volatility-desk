-- Migration: Add desk_admin_audit table (Task T2.7)
-- Safe to execute idempotently

CREATE TABLE IF NOT EXISTS desk_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  actor_id uuid NOT NULL REFERENCES users(id),
  action varchar(40) NOT NULL,
  result varchar(20) NOT NULL,
  ip inet
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON desk_admin_audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON desk_admin_audit(actor_id);
