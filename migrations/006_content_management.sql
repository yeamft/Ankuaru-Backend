CREATE TABLE news_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 200),
  title_am TEXT,
  summary TEXT NOT NULL CHECK (length(btrim(summary)) BETWEEN 10 AND 800),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 10 AND 50000),
  category TEXT NOT NULL CHECK (category IN ('Market', 'Origins', 'Platform', 'Export', 'Policy')),
  source TEXT NOT NULL DEFAULT 'ANKUARU',
  image_url TEXT,
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published')),
  created_by TEXT NOT NULL REFERENCES traders(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX news_posts_public_idx ON news_posts (status, published_at DESC);
CREATE INDEX news_posts_admin_idx ON news_posts (created_at DESC, id DESC);

CREATE TABLE exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency TEXT NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency TEXT NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  rate NUMERIC(20, 8) NOT NULL CHECK (rate > 0),
  effective_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL REFERENCES traders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (base_currency <> quote_currency)
);

CREATE INDEX exchange_rates_pair_effective_idx
  ON exchange_rates (base_currency, quote_currency, effective_at DESC);
