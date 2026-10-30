-- Migration: Add fills table for P&L source of truth (Task T2.1)
-- Safe to execute idempotently

CREATE TABLE IF NOT EXISTS fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_fill_id text NOT NULL,
  account_kind varchar(10) NOT NULL,
  user_id uuid REFERENCES users(id),
  instrument varchar(10) NOT NULL,
  symbol text NOT NULL,
  side varchar(4) NOT NULL,
  qty numeric NOT NULL,
  price numeric NOT NULL,
  fee numeric NOT NULL DEFAULT 0,
  fee_tax numeric NOT NULL DEFAULT 0,
  liquidity varchar(10),
  bot_run_id uuid,
  filled_at timestamptz NOT NULL,
  raw jsonb,
  UNIQUE (account_kind, exchange_fill_id)
);

CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills(filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_symbol ON fills(symbol);

