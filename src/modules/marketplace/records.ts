import { sql } from "drizzle-orm";
import { listings } from "../../infrastructure/database/schema.js";
import { INQUIRY_STATUSES } from "./schemas.js";

export { INQUIRY_STATUSES };

export const LISTING_STATUSES = [
  "Active", "Closing Soon", "Flagged", "Closed", "Rejected", "Pending Review", "Draft",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

/** Listings buyers can see and contact. */
export const LIVE_LISTING_STATUSES: readonly string[] = ["Active", "Closing Soon"];

/** `listings.status` is live; for queries whose `listings` table has no alias. */
export const isLiveListing = sql`${listings.status} in ('Active', 'Closing Soon')`;

export type Inquiry = {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  message: string;
  status: string;
  created_at: Date;
};
