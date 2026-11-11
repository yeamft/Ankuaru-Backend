-- Retain tombstones when a news post is deleted locally, so polling cannot
-- resurrect it. Snapshots keep the source article as imported.
CREATE TABLE legacy_news_imports (
  source_id TEXT PRIMARY KEY,
  news_post_id UUID UNIQUE REFERENCES news_posts(id) ON DELETE SET NULL,
  snapshot JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
