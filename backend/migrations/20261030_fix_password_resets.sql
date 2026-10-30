-- Migration: Fix desk_password_resets table (Task T1.3)
-- Safe to execute idempotently

ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'pending';
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id);
ALTER TABLE desk_password_resets ADD COLUMN IF NOT EXISTS pending_owner_approval boolean NOT NULL DEFAULT true;

-- Ensure code_hash and expires_at allow NULL for token_hash-based rows
ALTER TABLE desk_password_resets ALTER COLUMN code_hash DROP NOT NULL;
ALTER TABLE desk_password_resets ALTER COLUMN expires_at DROP NOT NULL;

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_pwreset_token ON desk_password_resets(token_hash) WHERE token_hash IS NOT NULL;

