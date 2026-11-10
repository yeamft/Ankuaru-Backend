-- Indexes for the lookups the API runs most, found by reviewing its queries.

-- "Has anyone inquired about this listing?" (delete checks) and the listing
-- side of inquiry joins scanned the whole inquiries table.
CREATE INDEX IF NOT EXISTS inquiries_listing_idx ON inquiries (listing_id);

-- Admin listing pages page newest first by (created_at, id), optionally by
-- intent; analytics count listings created since a date.
CREATE INDEX IF NOT EXISTS listings_created_idx ON listings (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS listings_intent_created_idx ON listings (intent, created_at DESC, id DESC);

-- The admin users list pages newest first; sign-up analytics count by date.
CREATE INDEX IF NOT EXISTS accounts_created_idx ON accounts (created_at DESC, id DESC);

-- A trader's own verification requests.
CREATE INDEX IF NOT EXISTS verification_requests_trader_idx ON verification_requests (trader_id, created_at DESC);

-- Daily readership counts every event in a date range, across posts.
CREATE INDEX IF NOT EXISTS news_post_events_created_idx ON news_post_events (created_at, kind);
