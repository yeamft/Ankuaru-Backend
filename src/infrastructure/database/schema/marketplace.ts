import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  date,
  numeric,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt } from "./columns.js";
import { catalogProducts, catalogProperties, catalogPropertyValues } from "./catalog.js";

export const listings = pgTable("listings", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  reference: text("reference").notNull(),
  intent: text("intent").notNull(),
  category: text("category").notNull(),
  product: text("product").notNull(),
  status: text("status").notNull().default("Active"),
  createdAt: createdAt(),
  quantity: text("quantity"),
  priceAmount: numeric("price_amount"),
  priceCurrency: text("price_currency").notNull().default("USD"),
  availableFrom: date("available_from"),
  description: text("description"),
  imageUrl: text("image_url"),
  region: text("region"),
  grade: text("grade"),
  process: text("process"),
  transactionType: text("transaction_type"),
  source: text("source").notNull().default("web"),
  sourceReference: text("source_reference"),
  productId: text("product_id").references(() => catalogProducts.id),
  /** Why staff rejected the listing; shown to its owner. */
  reviewNote: text("review_note"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /** Opens of the public detail page. */
  views: integer("views").notNull().default(0),
  /** Chosen by staff to lead the marketplace banner; only live listings show. */
  featured: boolean("featured").notNull().default(false),
  featuredAt: timestamp("featured_at", { withTimezone: true }),
}, (table) => [
  check("listings_intent_check", sql`${table.intent} in ('buy', 'sell')`),
  index("listings_owner_idx").on(table.ownerId, table.createdAt),
  index("listings_market_idx").on(table.status, table.intent, table.category, table.createdAt),
  uniqueIndex("listings_source_reference_idx").on(table.source, table.sourceReference).where(sql`${table.sourceReference} is not null`),
  index("listings_product_idx").on(table.productId),
]);

export const inquiries = pgTable("inquiries", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: text("listing_id").notNull().references(() => listings.id),
  buyerId: text("buyer_id").notNull(),
  sellerId: text("seller_id").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("New"),
  createdAt: createdAt(),
}, (table) => [
  index("inquiries_buyer_idx").on(table.buyerId, table.createdAt),
  index("inquiries_seller_idx").on(table.sellerId, table.createdAt),
]);

export const listingProperties = pgTable("listing_properties", {
  listingId: text("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => catalogProperties.id),
  valueId: uuid("value_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.listingId, table.propertyId] }),
  foreignKey({ columns: [table.valueId, table.propertyId], foreignColumns: [catalogPropertyValues.id, catalogPropertyValues.propertyId] }),
  index("listing_properties_value_idx").on(table.valueId),
]);
