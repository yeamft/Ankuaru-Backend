-- Retire the exact seed records from 001 without changing migration checksums.
-- Keep user-created listings and accounts, including those created in local development.
CREATE TEMP TABLE retired_demo_listings ON COMMIT DROP AS
SELECT id FROM listings
WHERE owner_id IN ('buyer-demo', 'seller-demo')
  AND (id, reference) IN (
    ('post_001', 'ANK-IOI-2026-0148'),
    ('post_002', 'ANK-IOI-2026-0152'),
    ('post_003', 'ANK-IOI-2026-0160'),
    ('post_004', 'ANK-IOI-2026-0168'),
    ('post_005', 'ANK-IOI-2026-0171'),
    ('post_006', 'ANK-IOI-2026-0175'),
    ('post_007', 'ANK-IOI-2026-0130'),
    ('post_008', 'ANK-IOI-2026-0180'),
    ('post_009', 'ANK-IOI-2026-0182'),
    ('post_010', 'ANK-IOI-2026-0122')
  );

DELETE FROM inquiries WHERE listing_id IN (SELECT id FROM retired_demo_listings);
DELETE FROM listings WHERE id IN (SELECT id FROM retired_demo_listings);

DELETE FROM traders
WHERE id IN ('buyer-demo', 'seller-demo')
  AND NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.id = traders.id)
  AND NOT EXISTS (SELECT 1 FROM listings WHERE owner_id = traders.id)
  AND NOT EXISTS (SELECT 1 FROM inquiries WHERE buyer_id = traders.id OR seller_id = traders.id)
  AND NOT EXISTS (SELECT 1 FROM verification_requests WHERE trader_id = traders.id);
