ALTER TABLE news_posts
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'News';
ALTER TABLE news_posts
  ADD CONSTRAINT news_posts_kind_check CHECK (kind IN ('News', 'Tender', 'Event'));
CREATE INDEX news_posts_kind_public_idx ON news_posts (kind, status, published_at DESC);
