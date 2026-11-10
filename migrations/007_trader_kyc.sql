ALTER TABLE traders ADD COLUMN phone TEXT;
ALTER TABLE traders ADD COLUMN city TEXT;
ALTER TABLE traders ADD COLUMN phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE traders ADD COLUMN verification_tier TEXT NOT NULL DEFAULT 'registered';
ALTER TABLE traders ADD CONSTRAINT traders_phone_key UNIQUE (phone);
ALTER TABLE traders ADD CONSTRAINT traders_verification_tier_check
  CHECK (verification_tier IN ('registered', 'individual', 'business'));

-- Preserve the existing boolean verification state as an individual review.
UPDATE traders SET verification_tier = 'individual' WHERE verified = TRUE;

ALTER TABLE verification_requests ADD COLUMN verification_type TEXT NOT NULL DEFAULT 'individual';
ALTER TABLE verification_requests ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE verification_requests ADD CONSTRAINT verification_requests_type_check
  CHECK (verification_type IN ('individual', 'business'));

CREATE TABLE phone_otp_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX phone_otp_expiry_idx ON phone_otp_codes (expires_at);
