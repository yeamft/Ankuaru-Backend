-- Resources imported from the legacy API. The row stays when staff delete the
-- resource locally (resource_id becomes NULL), so the next sync does not bring it back.
-- The snapshot holds the values last copied from the source.
CREATE TABLE legacy_resource_imports (
  source_id TEXT PRIMARY KEY,
  resource_id UUID UNIQUE REFERENCES resources(id) ON DELETE SET NULL,
  snapshot JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
