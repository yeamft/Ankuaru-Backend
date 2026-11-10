-- Staff can feature live listings; featured ones lead the marketplace banner.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS featured_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS listings_featured_idx ON listings (featured_at DESC) WHERE featured;
