-- Every trader-to-trader interaction, for staff oversight: one trader contacting
-- another about a listing, and each later status change on that conversation.
CREATE TABLE inquiry_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id UUID NOT NULL REFERENCES inquiries (id) ON DELETE CASCADE,
  -- The trader (or staff member) who acted.
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CONSTRAINT inquiry_events_kind_check CHECK (kind IN ('contacted', 'status_changed')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX inquiry_events_created_idx ON inquiry_events (created_at DESC, id DESC);
CREATE INDEX inquiry_events_inquiry_idx ON inquiry_events (inquiry_id, created_at);
CREATE INDEX inquiry_events_actor_idx ON inquiry_events (actor_id, created_at);

-- Earlier contacts: the trader who wrote is the one who does not own the listing.
INSERT INTO inquiry_events (inquiry_id, actor_id, kind, from_status, to_status, created_at)
SELECT i.id,
       CASE WHEN i.buyer_id = l.owner_id THEN i.seller_id ELSE i.buyer_id END,
       'contacted', NULL, 'New', i.created_at
FROM inquiries i
JOIN listings l ON l.id = i.listing_id;
