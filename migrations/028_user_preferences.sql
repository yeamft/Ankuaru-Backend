-- Per-account settings chosen on the dashboard Settings page. A missing row means
-- the defaults below.
CREATE TABLE user_preferences (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'en' CONSTRAINT user_preferences_language_check CHECK (language IN ('en', 'am')),
  currency TEXT NOT NULL DEFAULT 'USD' CONSTRAINT user_preferences_currency_check CHECK (currency IN ('USD', 'ETB')),
  notify_inquiries BOOLEAN NOT NULL DEFAULT true,
  notify_listing_updates BOOLEAN NOT NULL DEFAULT true,
  notify_market_news BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
