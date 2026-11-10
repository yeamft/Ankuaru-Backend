-- Product catalog: categories hold products, and properties (optionally scoped
-- to one product) offer a fixed set of values. Listings point at a product and
-- store one value per property, replacing the coffee-only columns.

CREATE TABLE catalog_categories (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL,
  name_am TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE catalog_products (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  category_id TEXT NOT NULL REFERENCES catalog_categories(id),
  -- The product's name within its category; `id` is unique across categories.
  key TEXT NOT NULL CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL,
  name_am TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, key),
  UNIQUE (id, category_id)
);

CREATE TABLE catalog_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id TEXT NOT NULL REFERENCES catalog_categories(id),
  -- NULL applies the property to every product in the category.
  product_id TEXT,
  -- Unique per category, so a listing's properties can be keyed by it.
  key TEXT NOT NULL CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL,
  name_am TEXT,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, key),
  -- A product-scoped property must belong to the product's own category.
  FOREIGN KEY (product_id, category_id) REFERENCES catalog_products(id, category_id)
);

CREATE TABLE catalog_property_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES catalog_properties(id),
  key TEXT NOT NULL CHECK (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL,
  name_am TEXT,
  -- Lowercase spellings that also mean this value, e.g. "sidamo" for Sidama.
  aliases TEXT[] NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, key),
  UNIQUE (id, property_id)
);

CREATE TABLE listing_properties (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES catalog_properties(id),
  value_id UUID NOT NULL,
  PRIMARY KEY (listing_id, property_id),
  -- The value must be one of the property's own values.
  FOREIGN KEY (value_id, property_id) REFERENCES catalog_property_values(id, property_id)
);
CREATE INDEX listing_properties_value_idx ON listing_properties (value_id);

ALTER TABLE listings ADD COLUMN product_id TEXT REFERENCES catalog_products(id);
CREATE INDEX listings_product_idx ON listings (product_id);

INSERT INTO catalog_categories (id, name, name_am, sort_order) VALUES
  ('coffee', 'Coffee', 'ቡና', 1),
  ('spices-herbs', 'Spice & Herbs', 'ቅመማ ቅመሞች', 2),
  ('pulses-legumes', 'Pulses & Legumes', 'ጥራጥሬዎች', 3),
  ('vegetables', 'Vegetables', 'አትክልቶች', 4),
  ('oil-seeds', 'Oil Seeds', 'የቅባት እህሎች', 5),
  ('fruit-crops', 'Fruit Crops', 'ፍራፍሬዎች', 6),
  ('root-crops', 'Root Crops', 'የስርስር ሰብሎች', 7),
  ('building-materials', 'Building Materials', 'የግንባታ እቃዎች', 8),
  ('grains-cereals', 'Grains and Cereals', 'የእህል ሰብሎች', 9);

INSERT INTO catalog_products (id, category_id, key, name, name_am, sort_order) VALUES
  ('export-coffee', 'coffee', 'export-coffee', 'Export Coffee', 'ኤክስፖርት ቡና', 1),
  ('roasted-coffee', 'coffee', 'roasted-coffee', 'Roasted Coffee', 'የተቆላ ቡና', 2),
  ('reject-coffee', 'coffee', 'reject-coffee', 'Reject Coffee', NULL, 3);

-- Until admins add real products, each other category has one general product.
INSERT INTO catalog_products (id, category_id, key, name, name_am)
SELECT id || '-general', id, 'general', 'General', 'አጠቃላይ'
FROM catalog_categories WHERE id <> 'coffee';

INSERT INTO catalog_properties (category_id, key, name, sort_order) VALUES
  ('coffee', 'region', 'Region', 1),
  ('coffee', 'grade', 'Grade', 2),
  ('coffee', 'process', 'Process', 3),
  ('coffee', 'transaction', 'Transaction', 4);

INSERT INTO catalog_property_values (property_id, key, name, name_am, aliases, sort_order)
SELECT p.id, v.key, v.name, v.name_am, v.aliases, v.sort_order
FROM catalog_properties p
JOIN (VALUES
  ('region', 'yirgacheffe', 'Yirgacheffe', NULL, '{yirgachefe}'::text[], 1),
  ('region', 'kochere', 'Kochere', NULL, '{}', 2),
  ('region', 'guji', 'Guji', NULL, '{}', 3),
  ('region', 'limu', 'Limu', NULL, '{}', 4),
  ('region', 'godere', 'Godere', NULL, '{}', 5),
  ('region', 'anderacha', 'Anderacha', NULL, '{}', 6),
  ('region', 'bebeka', 'Bebeka', NULL, '{}', 7),
  ('region', 'east-wollega', 'East Wollega', NULL, '{}', 8),
  ('region', 'tepi', 'Tepi', NULL, '{}', 9),
  ('region', 'jimma', 'Jimma', NULL, '{djimma}', 10),
  ('region', 'bale', 'Bale', NULL, '{}', 11),
  ('region', 'wenago', 'Wenago', NULL, '{}', 12),
  ('region', 'gelana-abaya', 'Gelana Abaya', NULL, '{}', 13),
  ('region', 'sidama', 'Sidama', NULL, '{sidamo}', 14),
  ('region', 'kaffa', 'Kaffa', NULL, '{keffa}', 15),
  ('region', 'yeki', 'Yeki', NULL, '{}', 16),
  ('region', 'bench-maji', 'Bench Maji', NULL, '{benchmaji,"banch maji"}', 17),
  ('region', 'kelem-wollega', 'Kelem Wollega', NULL, '{}', 18),
  ('region', 'gimbi', 'Gimbi', NULL, '{}', 19),
  ('region', 'lekempti', 'Lekempti', NULL, '{nekemte}', 20),
  ('region', 'harar', 'Harar', NULL, '{}', 21),
  ('region', 'forest', 'Forest', NULL, '{}', 22),
  ('region', 'illubabor', 'Illubabor', NULL, '{"ilu aba bora"}', 23),
  ('region', 'any-region', 'Any Region', NULL, '{}', 24),
  ('grade', '1', 'Grade 1', NULL, '{g1,"grade 1"}', 1),
  ('grade', '2', 'Grade 2', NULL, '{g2,"grade 2"}', 2),
  ('grade', '3', 'Grade 3', NULL, '{g3,"grade 3"}', 3),
  ('grade', '4', 'Grade 4', NULL, '{g4,"grade 4"}', 4),
  ('grade', '5', 'Grade 5', NULL, '{g5,"grade 5"}', 5),
  ('grade', 'ng', 'NG', NULL, '{}', 6),
  ('grade', 'ug', 'UG', NULL, '{}', 7),
  ('process', 'washed', 'Washed', 'የታጠበ', '{}', 1),
  ('process', 'unwashed', 'Unwashed', 'ያልታጠበ', '{}', 2),
  ('process', 'fermented', 'Fermented', 'ፈርመንትድ', '{}', 3),
  ('process', 'natural', 'Natural', NULL, '{}', 4),
  ('transaction', 'horizontal', 'Horizontal', 'ቅብብል', '{}', 1),
  ('transaction', 'vertical', 'Vertical', 'ትስስር', '{}', 2)
) AS v(property, key, name, name_am, aliases, sort_order) ON v.property = p.key
WHERE p.category_id = 'coffee';

-- Existing listings stored a product id, key or name; link the ones that match.
UPDATE listings l SET product_id = p.id
FROM catalog_products p
WHERE p.category_id = l.category
  AND lower(btrim(l.product)) IN (p.id, p.key, lower(p.name));

-- Move matching coffee attributes into listing properties. Values that match no
-- option (such as "G1 & G2") stay in the legacy columns, which are no longer read.
INSERT INTO listing_properties (listing_id, property_id, value_id)
SELECT DISTINCT ON (l.id, p.id) l.id, p.id, v.id
FROM listings l
CROSS JOIN LATERAL (VALUES
  ('region', l.region), ('grade', l.grade), ('process', l.process),
  ('transaction', l.transaction_type)
) AS legacy(key, value)
JOIN catalog_properties p ON p.category_id = 'coffee' AND p.key = legacy.key
JOIN catalog_property_values v ON v.property_id = p.id
  AND (lower(btrim(legacy.value)) IN (v.key, lower(v.name))
       OR lower(btrim(legacy.value)) = ANY (v.aliases))
WHERE l.category = 'coffee' AND legacy.value IS NOT NULL
ORDER BY l.id, p.id, v.sort_order;
