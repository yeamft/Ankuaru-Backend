-- Imported people have trader profiles; login accounts are created only after
-- the owner proves control of an unambiguous phone during registration.
CREATE TABLE legacy_users (
  source_id TEXT PRIMARY KEY,
  trader_id TEXT NOT NULL UNIQUE REFERENCES traders(id),
  chat_id TEXT,
  claim_phone TEXT,
  claim_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_at TIMESTAMPTZ,
  cutover_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX legacy_users_claim_phone_idx ON legacy_users(claim_phone);

-- Retain tombstones when a listing is deleted locally, so polling cannot
-- resurrect it. The snapshot detects edits made on the new site.
CREATE TABLE legacy_listing_imports (
  source_key TEXT PRIMARY KEY,
  listing_id TEXT UNIQUE REFERENCES listings(id) ON DELETE SET NULL,
  source_user_id TEXT NOT NULL REFERENCES legacy_users(source_id),
  snapshot JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
