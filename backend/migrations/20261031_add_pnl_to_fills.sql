-- Migration: Add Greek P&L columns to fills table (Task T4.3)
-- Safe to execute idempotently

ALTER TABLE fills ADD COLUMN IF NOT EXISTS total_pnl numeric;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS delta_pnl numeric;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS gamma_pnl numeric;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS theta_pnl numeric;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS vega_pnl numeric;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS other_pnl numeric;
