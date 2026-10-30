-- Migration: Add desk_feedback table (Task T1.6)
-- Safe to execute idempotently

CREATE TABLE IF NOT EXISTS desk_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  category varchar(10) NOT NULL,
  message text NOT NULL,
  submitted_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_desk_feedback_user ON desk_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_desk_feedback_submitted ON desk_feedback(submitted_at);

