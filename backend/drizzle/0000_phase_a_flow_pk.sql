-- Phase A: option_flow_buckets composite primary key (symbol, time)
-- Existing data is single-symbol ('BTC'); this migration is non-destructive.
ALTER TABLE option_flow_buckets DROP CONSTRAINT IF EXISTS option_flow_buckets_pkey;
ALTER TABLE option_flow_buckets ADD CONSTRAINT option_flow_buckets_symbol_time_pk PRIMARY KEY (symbol, time);
