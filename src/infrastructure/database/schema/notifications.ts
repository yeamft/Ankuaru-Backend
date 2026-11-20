import { sql } from "drizzle-orm";
import { boolean, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";
import { accounts } from "./identity.js";
import { listings } from "./marketplace.js";

/**
 * What a trader wants to hear about. Matching runs in the `notify_listing_alerts`
 * trigger (migration 029) whenever a listing goes live.
 */
export const listingAlerts = pgTable("listing_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  intent: text("intent"),
  categories: text("categories").array().notNull().default(sql`'{}'`),
  products: text("products").array().notNull().default(sql`'{}'`),
  keyword: text("keyword"),
  regions: text("regions").array().notNull().default(sql`'{}'`),
  processes: text("processes").array().notNull().default(sql`'{}'`),
  transactionTypes: text("transaction_types").array().notNull().default(sql`'{}'`),
  grades: text("grades").array().notNull().default(sql`'{}'`),
  statuses: text("statuses").array().notNull().default(sql`'{Active}'`),
  minQuantity: numeric("min_quantity"),
  maxQuantity: numeric("max_quantity"),
  priceCurrency: text("price_currency"),
  minPrice: numeric("min_price"),
  maxPrice: numeric("max_price"),
  sellerVerification: text("seller_verification").notNull().default("any"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("listing_alerts_account_idx").on(table.accountId, table.createdAt)]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  listingId: text("listing_id").references(() => listings.id, { onDelete: "cascade" }),
  alertId: uuid("alert_id").references(() => listingAlerts.id, { onDelete: "set null" }),
  listingStatus: text("listing_status"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [index("notifications_account_idx").on(table.accountId, table.createdAt.desc(), table.id.desc())]);
