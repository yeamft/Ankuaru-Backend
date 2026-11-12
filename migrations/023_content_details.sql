-- Structured details for tenders and events, so they no longer live only in free text.
ALTER TABLE news_posts
  ADD COLUMN location TEXT,
  ADD COLUMN quantity TEXT,
  ADD COLUMN deadline_at TIMESTAMPTZ,
  ADD COLUMN starts_at TIMESTAMPTZ,
  ADD COLUMN ends_at TIMESTAMPTZ,
  ADD COLUMN contact TEXT,
  ADD COLUMN link_url TEXT;

ALTER TABLE news_posts ADD CONSTRAINT news_posts_event_dates_check
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at);
