ALTER TABLE news_posts
  ADD COLUMN submitted_by TEXT REFERENCES traders(id);

ALTER TABLE news_posts DROP CONSTRAINT news_posts_status_check;
ALTER TABLE news_posts ADD CONSTRAINT news_posts_status_check
  CHECK (status IN ('Draft', 'Pending Review', 'Published', 'Rejected'));
ALTER TABLE news_posts ADD CONSTRAINT news_posts_submission_kind_check
  CHECK (submitted_by IS NULL OR kind IN ('Tender', 'Event'));

CREATE INDEX news_posts_submitter_idx ON news_posts (submitted_by, created_at DESC, id DESC);
