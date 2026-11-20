-- Listings posted from the web form store option IDs ("east-wollega", "washed",
-- "export-coffee") while imported ones store labels ("East Wollega",
-- "Washed / የታጠበ"). Alerts now compare both forms as slugs, so either matches.

-- "East Wollega" / "east-wollega" / "Washed / የታጠበ" (English part) → "east-wollega" / "washed".
CREATE FUNCTION alert_slug(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(btrim(regexp_replace(lower(btrim(split_part(value, ' / ', 1))), '[^a-z0-9]+', '-', 'g'), '-'), '')
$$;

-- A stored value for people to read: option IDs become words ("east-wollega" → "East Wollega").
CREATE FUNCTION alert_label(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value ~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN initcap(replace(value, '-', ' '))
              ELSE nullif(btrim(value), '') END
$$;

CREATE OR REPLACE FUNCTION notify_listing_alerts() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  owner_verified BOOLEAN;
  owner_active BOOLEAN;
  product_name TEXT;
  product_name_am TEXT;
  quintals NUMERIC;
  haystack TEXT;
  product_slugs TEXT[];
  region_slug TEXT;
  process_slug TEXT;
  transaction_slug TEXT;
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
  -- Option IDs are searched as words too ("east-wollega" → "east wollega").
  haystack := lower(concat_ws(' ', NEW.product, alert_label(NEW.product), product_name, product_name_am,
    NEW.description, NEW.region, alert_label(NEW.region), NEW.grade, NEW.process, alert_label(NEW.process),
    NEW.reference));
  product_slugs := ARRAY[alert_slug(NEW.product), alert_slug(product_name), alert_slug(NEW.product_id)];
  region_slug := alert_slug(NEW.region);
  process_slug := alert_slug(NEW.process);
  transaction_slug := alert_slug(NEW.transaction_type);

  FOR created IN
    WITH inserted AS (
      INSERT INTO notifications (account_id, kind, title, body, listing_id, alert_id, listing_status)
      SELECT DISTINCT ON (a.account_id)
        a.account_id,
        'listing_alert',
        CASE WHEN NEW.status = 'Closing Soon' THEN 'Closing soon: '
             WHEN NEW.intent = 'sell' THEN 'For sale: '
             ELSE 'Wanted: ' END
          || coalesce(product_name, alert_label(btrim(split_part(NEW.product, ' / ', 1)))),
        concat_ws(' · ', alert_label(NEW.region), nullif(btrim(NEW.quantity), ''),
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
          SELECT 1 FROM unnest(a.products) p WHERE alert_slug(p) = ANY (product_slugs)))
        AND (a.keyword IS NULL OR position(lower(a.keyword) IN haystack) > 0)
        AND (cardinality(a.regions) = 0 OR EXISTS (
          SELECT 1 FROM unnest(a.regions) r WHERE alert_slug(r) = region_slug))
        AND (cardinality(a.processes) = 0 OR EXISTS (
          SELECT 1 FROM unnest(a.processes) p WHERE alert_slug(p) = process_slug))
        AND (cardinality(a.transaction_types) = 0 OR EXISTS (
          SELECT 1 FROM unnest(a.transaction_types) x WHERE alert_slug(x) = transaction_slug))
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
