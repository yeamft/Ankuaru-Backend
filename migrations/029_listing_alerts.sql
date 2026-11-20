-- Listing alerts: traders save what they are looking for, and a notification is
-- written for them whenever a listing that matches goes live. Matching happens in a
-- trigger so every way a listing goes live (posting, staff approval, re-publishing,
-- the legacy sync) is covered, exactly once, in the same transaction.

-- A listing's quantity in quintals, or NULL when it cannot be measured.
-- Posted quantities look like "6 FCL / ኮንቴነር / 200": count, unit, Amharic unit,
-- and quintals per unit. Older ones are "480 Quintal" or "20 MT".
CREATE FUNCTION listing_quantity_quintals(quantity TEXT) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN amount IS NULL THEN NULL
    WHEN factor IS NOT NULL THEN amount * factor
    WHEN unit IN ('quintal', 'quintals', 'qt', 'qtl') THEN amount
    WHEN unit IN ('kg', 'kgs', 'kilogram', 'kilograms') THEN amount / 100
    WHEN unit IN ('mt', 't', 'ton', 'tons', 'tonne', 'tonnes') THEN amount * 10
    WHEN unit = 'fcl' THEN amount * 200
  END
  FROM (
    SELECT
      replace(substring(quantity FROM '^\s*([0-9][0-9,]*(?:\.[0-9]+)?)'), ',', '')::NUMERIC AS amount,
      lower(substring(quantity FROM '^\s*[0-9][0-9,]*(?:\.[0-9]+)?\s*([A-Za-z]+)')) AS unit,
      substring(split_part(quantity, ' / ', 3) FROM '^\s*([0-9]+(?:\.[0-9]+)?)\s*$')::NUMERIC AS factor
  ) parts
$$;

CREATE TABLE listing_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name TEXT NOT NULL CONSTRAINT listing_alerts_name_check CHECK (char_length(name) BETWEEN 1 AND 80),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- Every filter below is optional: NULL or an empty array matches anything.
  intent TEXT CONSTRAINT listing_alerts_intent_check CHECK (intent IN ('buy', 'sell')),
  categories TEXT[] NOT NULL DEFAULT '{}',
  -- Product names ("Export Coffee") or catalog product IDs.
  products TEXT[] NOT NULL DEFAULT '{}',
  -- Free text searched in the product, description, region, grade and reference.
  keyword TEXT CONSTRAINT listing_alerts_keyword_check CHECK (char_length(keyword) BETWEEN 1 AND 100),
  regions TEXT[] NOT NULL DEFAULT '{}',
  -- English names; listings store "Washed / የታጠበ", matched on the English part.
  processes TEXT[] NOT NULL DEFAULT '{}',
  transaction_types TEXT[] NOT NULL DEFAULT '{}',
  grades TEXT[] NOT NULL DEFAULT '{}',
  -- Which live statuses notify: a new listing, one about to close, or both.
  statuses TEXT[] NOT NULL DEFAULT '{Active}' CONSTRAINT listing_alerts_statuses_check
    CHECK (cardinality(statuses) > 0 AND statuses <@ ARRAY['Active', 'Closing Soon']),
  -- In quintals; listings without a measurable quantity do not match a range.
  min_quantity NUMERIC CONSTRAINT listing_alerts_min_quantity_check CHECK (min_quantity >= 0),
  max_quantity NUMERIC CONSTRAINT listing_alerts_max_quantity_check CHECK (max_quantity >= 0),
  -- A price range only matches priced listings in the same currency.
  price_currency TEXT CONSTRAINT listing_alerts_price_currency_check CHECK (price_currency IN ('USD', 'ETB')),
  min_price NUMERIC CONSTRAINT listing_alerts_min_price_check CHECK (min_price >= 0),
  max_price NUMERIC CONSTRAINT listing_alerts_max_price_check CHECK (max_price >= 0),
  seller_verification TEXT NOT NULL DEFAULT 'any' CONSTRAINT listing_alerts_seller_verification_check
    CHECK (seller_verification IN ('any', 'verified', 'unverified')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_alerts_quantity_range_check CHECK (min_quantity IS NULL OR max_quantity IS NULL OR min_quantity <= max_quantity),
  CONSTRAINT listing_alerts_price_range_check CHECK (min_price IS NULL OR max_price IS NULL OR min_price <= max_price),
  CONSTRAINT listing_alerts_price_currency_required_check
    CHECK ((min_price IS NULL AND max_price IS NULL) OR price_currency IS NOT NULL)
);

CREATE INDEX listing_alerts_account_idx ON listing_alerts (account_id, created_at);
CREATE INDEX listing_alerts_enabled_idx ON listing_alerts (account_id) WHERE enabled;

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CONSTRAINT notifications_kind_check CHECK (kind IN ('listing_alert')),
  title TEXT NOT NULL,
  body TEXT,
  listing_id TEXT REFERENCES listings (id) ON DELETE CASCADE,
  alert_id UUID REFERENCES listing_alerts (id) ON DELETE SET NULL,
  -- The status the listing entered; one notification per listing and status.
  listing_status TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_account_idx ON notifications (account_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread_idx ON notifications (account_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_listing_alert_idx ON notifications (account_id, listing_id, listing_status)
  WHERE kind = 'listing_alert';

CREATE FUNCTION notify_listing_alerts() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  owner_verified BOOLEAN;
  owner_active BOOLEAN;
  product_name TEXT;
  product_name_am TEXT;
  quintals NUMERIC;
  haystack TEXT;
  created RECORD;
BEGIN
  IF NEW.status NOT IN ('Active', 'Closing Soon') THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN RETURN NULL; END IF;

  -- Public pages hide listings whose owner is not active; so do alerts.
  SELECT t.verified, t.status = 'Active' INTO owner_verified, owner_active
  FROM traders t WHERE t.id = NEW.owner_id;
  IF NOT coalesce(owner_active, false) THEN RETURN NULL; END IF;

  SELECT cp.name, cp.name_am INTO product_name, product_name_am
  FROM catalog_products cp WHERE cp.id = NEW.product_id;
  quintals := listing_quantity_quintals(NEW.quantity);
  haystack := lower(concat_ws(' ', NEW.product, product_name, product_name_am, NEW.description,
    NEW.region, NEW.grade, NEW.process, NEW.reference));

  FOR created IN
    WITH inserted AS (
      INSERT INTO notifications (account_id, kind, title, body, listing_id, alert_id, listing_status)
      SELECT DISTINCT ON (a.account_id)
        a.account_id,
        'listing_alert',
        CASE WHEN NEW.status = 'Closing Soon' THEN 'Closing soon: '
             WHEN NEW.intent = 'sell' THEN 'For sale: '
             ELSE 'Wanted: ' END
          || coalesce(product_name, btrim(split_part(NEW.product, ' / ', 1))),
        concat_ws(' · ', nullif(btrim(NEW.region), ''), nullif(btrim(NEW.quantity), ''),
          'Matches "' || a.name || '"'),
        NEW.id,
        a.id,
        NEW.status
      FROM listing_alerts a
      JOIN traders t ON t.id = a.account_id AND t.status = 'Active'
      WHERE a.enabled
        AND a.account_id <> NEW.owner_id
        AND NEW.status = ANY (a.statuses)
        AND (a.intent IS NULL OR a.intent = NEW.intent)
        AND (cardinality(a.categories) = 0 OR NEW.category = ANY (a.categories))
        AND (cardinality(a.products) = 0 OR EXISTS (
          SELECT 1 FROM unnest(a.products) p WHERE lower(p) IN (
            lower(NEW.product), lower(btrim(split_part(NEW.product, ' / ', 1))),
            lower(product_name), lower(NEW.product_id))))
        AND (a.keyword IS NULL OR position(lower(a.keyword) IN haystack) > 0)
        AND (cardinality(a.regions) = 0 OR EXISTS (
          SELECT 1 FROM unnest(a.regions) r WHERE lower(r) IN (
            lower(btrim(NEW.region)), lower(btrim(split_part(NEW.region, ' / ', 1))))))
        AND (cardinality(a.processes) = 0 OR EXISTS (
          SELECT 1 FROM unnest(a.processes) p WHERE lower(p) IN (
            lower(btrim(NEW.process)), lower(btrim(split_part(NEW.process, ' / ', 1))))))
        AND (cardinality(a.transaction_types) = 0 OR EXISTS (
          SELECT 1 FROM unnest(a.transaction_types) x WHERE lower(x) IN (
            lower(btrim(NEW.transaction_type)), lower(btrim(split_part(NEW.transaction_type, ' / ', 1))))))
        AND (cardinality(a.grades) = 0 OR upper(btrim(NEW.grade)) = ANY (a.grades))
        AND (a.min_quantity IS NULL OR quintals >= a.min_quantity)
        AND (a.max_quantity IS NULL OR quintals <= a.max_quantity)
        AND (a.price_currency IS NULL OR (
          NEW.price_amount IS NOT NULL AND NEW.price_currency = a.price_currency
          AND (a.min_price IS NULL OR NEW.price_amount >= a.min_price)
          AND (a.max_price IS NULL OR NEW.price_amount <= a.max_price)))
        AND (a.seller_verification = 'any' OR (a.seller_verification = 'verified') = owner_verified)
      ORDER BY a.account_id, a.created_at
      ON CONFLICT (account_id, listing_id, listing_status) WHERE kind = 'listing_alert' DO NOTHING
      RETURNING id, account_id
    )
    SELECT id, account_id FROM inserted
  LOOP
    -- Delivered to open event streams once the transaction commits.
    PERFORM pg_notify('ankuaru_events', json_build_object(
      'id', 'evt_' || created.id,
      'event_type', 'notification.created',
      'recipient_user_id', created.account_id,
      'notification_id', created.id,
      'occurred_at', now()
    )::TEXT);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER listings_notify_alerts
AFTER INSERT OR UPDATE OF status ON listings
FOR EACH ROW EXECUTE FUNCTION notify_listing_alerts();
