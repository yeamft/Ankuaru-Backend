CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('buy', 'sell')),
  category TEXT NOT NULL,
  product TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep the initial schema forward-compatible when this migration is applied to
-- an existing local database created before the listing API was introduced.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS quantity TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_amount NUMERIC;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS available_from DATE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS grade TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS process TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS transaction_type TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS source_reference TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS listings_source_reference_idx
  ON listings (source, source_reference)
  WHERE source_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'New',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traders (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'both' CHECK (role IN ('buyer', 'seller', 'both')),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Active', 'Pending', 'Suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trader_id TEXT NOT NULL REFERENCES traders(id),
  document_summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Declined')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inquiries_buyer_idx ON inquiries (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inquiries_seller_idx ON inquiries (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_owner_idx ON listings (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_market_idx ON listings (status, intent, category, created_at DESC);
CREATE INDEX IF NOT EXISTS verification_requests_queue_idx ON verification_requests (status, created_at);
CREATE INDEX IF NOT EXISTS audit_events_target_idx ON audit_events (target_type, target_id, created_at DESC);

INSERT INTO traders (id, display_name, role, verified, status)
VALUES
  ('buyer-demo', 'Demo buyer', 'buyer', FALSE, 'Active'),
  ('seller-demo', 'Demo supplier', 'seller', TRUE, 'Active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO platform_settings (setting_key, setting_value)
VALUES
  ('marketplace', '{"maintenanceMode": false, "autoPublishVerified": false, "telegramImportsRequireReview": true}'::jsonb),
  ('notifications', '{"emailAlerts": true, "dailySummary": true}'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO listings (id, owner_id, reference, intent, category, product, status)
VALUES
  ('post_001', 'buyer-demo', 'ANK-IOI-2026-0148', 'buy', 'coffee', 'Export Coffee', 'Active'),
  ('post_002', 'seller-demo', 'ANK-IOI-2026-0152', 'sell', 'coffee', 'Export Coffee', 'Active'),
  ('post_003', 'buyer-demo', 'ANK-IOI-2026-0160', 'buy', 'coffee', 'Roasted Coffee', 'Active'),
  ('post_004', 'seller-demo', 'ANK-IOI-2026-0168', 'sell', 'coffee', 'Reject Coffee', 'Active'),
  ('post_005', 'seller-demo', 'ANK-IOI-2026-0171', 'sell', 'coffee', 'Export Coffee', 'Active'),
  ('post_006', 'buyer-demo', 'ANK-IOI-2026-0175', 'buy', 'coffee', 'Export Coffee', 'Active'),
  ('post_007', 'seller-demo', 'ANK-IOI-2026-0130', 'sell', 'coffee', 'Export Coffee', 'Active'),
  ('post_008', 'buyer-demo', 'ANK-IOI-2026-0180', 'buy', 'spices-herbs', 'Dried Chili & Korarima', 'Active'),
  ('post_009', 'seller-demo', 'ANK-IOI-2026-0182', 'sell', 'coffee', 'Export Coffee', 'Active'),
  ('post_010', 'buyer-demo', 'ANK-IOI-2026-0122', 'buy', 'pulses-legumes', 'Pulses', 'Active')
ON CONFLICT (id) DO NOTHING;
