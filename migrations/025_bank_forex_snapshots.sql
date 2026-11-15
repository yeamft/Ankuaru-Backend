CREATE TABLE bank_forex_snapshots (
  source_id text PRIMARY KEY,
  effective_at timestamptz NOT NULL,
  source_updated_at timestamptz NOT NULL,
  source text NOT NULL,
  rates jsonb NOT NULL CHECK (jsonb_typeof(rates) = 'array'),
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_forex_latest_idx ON bank_forex_snapshots (effective_at DESC, source_updated_at DESC);
