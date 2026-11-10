-- Staff approve or reject trader listings before they go live. Rejections keep
-- the reason so the trader can fix and resubmit.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS listings_review_queue_idx ON listings (status, created_at)
  WHERE status = 'Pending Review';
