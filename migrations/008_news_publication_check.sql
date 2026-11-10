ALTER TABLE news_posts ADD CONSTRAINT news_posts_published_at_check
  CHECK (status <> 'Published' OR published_at IS NOT NULL);
