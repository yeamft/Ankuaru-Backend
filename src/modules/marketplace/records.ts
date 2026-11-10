import { uuidSchema } from "./schemas.js";

// node-pg returns NUMERIC and BIGINT as strings and DATE as a local-midnight
// Date, so the casts keep the JSON shapes the frontend expects. The owner
// subqueries assume the statement's table is `listings` without an alias.
export const LISTING_COLUMNS = `id, owner_id, reference, intent, category, product, quantity,
  price_amount::double precision AS price_amount, price_currency,
  available_from::text AS available_from, description, image_url, region, grade, process,
  transaction_type, source, source_reference, status, created_at,
  (SELECT display_name FROM traders WHERE traders.id = listings.owner_id) AS owner_name,
  COALESCE((SELECT verified FROM traders WHERE traders.id = listings.owner_id), false)
    AS owner_verified`;

export const INQUIRY_COLUMNS = `id, listing_id, buyer_id, seller_id, message, status, created_at`;

export const LIVE_LISTING = `status IN ('Active', 'Closing Soon')`;

export type Inquiry = {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  message: string;
  status: string;
  created_at: Date;
};

export const INQUIRY_STATUSES = ["New", "Responded", "Resolved", "Closed"];

export const isUuid = (value: string) => uuidSchema.safeParse(value).success;

