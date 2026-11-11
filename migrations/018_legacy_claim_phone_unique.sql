CREATE UNIQUE INDEX legacy_users_unclaimed_phone_unique_idx
  ON legacy_users(claim_phone)
  WHERE claim_phone IS NOT NULL AND claim_blocked = FALSE AND claimed_at IS NULL;
