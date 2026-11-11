UPDATE listings AS listing
SET status = 'Active'
FROM legacy_listing_imports AS imported
JOIN legacy_users AS legacy_user
  ON legacy_user.source_id = imported.source_user_id
WHERE listing.id = imported.listing_id
  AND listing.source = 'legacy-ankuaru'
  AND listing.status = 'Pending Review'
  AND legacy_user.claimed_at IS NULL
  AND (imported.snapshot->>'status')::BOOLEAN IS TRUE
  AND (imported.snapshot->>'hidden_by_admin')::BOOLEAN IS FALSE;
