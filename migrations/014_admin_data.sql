-- Real data for the admin console: catalog details, views, reference prices,
-- news readership and resources. Everything here was shown from browser-only
-- sample data before.

-- Products: how they are traded and a note for traders.
ALTER TABLE catalog_products
  ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'Quintal',
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE catalog_products DROP CONSTRAINT IF EXISTS catalog_products_unit_check;
ALTER TABLE catalog_products
  ADD CONSTRAINT catalog_products_unit_check CHECK (unit IN ('Quintal', 'MT', 'kg', 'Bag', 'Piece'));

-- Attributes: answered from a list of values, as a number, or as free text.
ALTER TABLE catalog_properties
  ADD COLUMN IF NOT EXISTS input_type text NOT NULL DEFAULT 'select';
ALTER TABLE catalog_properties DROP CONSTRAINT IF EXISTS catalog_properties_input_type_check;
ALTER TABLE catalog_properties
  ADD CONSTRAINT catalog_properties_input_type_check CHECK (input_type IN ('select', 'number', 'text'));

-- Listings: how often the public detail page was opened.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS views integer NOT NULL DEFAULT 0;

-- News readership: one row per view or share. `visitor` is an anonymous id the
-- browser keeps, so unique readers can be counted without accounts.
CREATE TABLE IF NOT EXISTS news_post_events (
  id bigserial PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES news_posts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('view', 'share')),
  visitor text NOT NULL CHECK (char_length(visitor) BETWEEN 8 AND 64),
  read_seconds integer CHECK (read_seconds IS NULL OR read_seconds BETWEEN 0 AND 7200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_post_events_post_idx ON news_post_events (post_id, kind, created_at);

-- Reference market prices per product, entered by staff.
CREATE TABLE IF NOT EXISTS market_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id text NOT NULL REFERENCES catalog_products(id),
  price numeric NOT NULL CHECK (price > 0),
  currency text NOT NULL DEFAULT 'ETB' CHECK (currency IN ('ETB', 'USD')),
  market text NOT NULL CHECK (char_length(market) BETWEEN 2 AND 80),
  price_date date NOT NULL CHECK (price_date <= current_date + 1),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS market_prices_product_idx ON market_prices (product_id, price_date DESC);

-- Guides, reports, regulations and videos for traders.
CREATE TABLE IF NOT EXISTS resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 4 AND 200),
  type text NOT NULL CHECK (type IN ('Guide', 'Report', 'Regulation', 'Video')),
  category_id text NOT NULL DEFAULT 'all',
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 10 AND 300),
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_status_idx ON resources (status, created_at DESC);
