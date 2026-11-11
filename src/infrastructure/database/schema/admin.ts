import { sql } from "drizzle-orm";
import { bigserial, boolean, check, date, index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { catalogProducts } from "./catalog.js";
import { traders } from "./identity.js";
import { createdAt, updatedAt } from "./columns.js";

export const verificationRequests = pgTable("verification_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  traderId: text("trader_id").notNull().references(() => traders.id),
  verificationType: text("verification_type").notNull().default("individual"),
  details: jsonb("details").notNull().default({}),
  documentSummary: text("document_summary").notNull(),
  status: text("status").notNull().default("Pending"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  check("verification_requests_status_check", sql`${table.status} in ('Pending', 'Approved', 'Declined')`),
  check("verification_requests_type_check", sql`${table.verificationType} in ('individual', 'business')`),
  index("verification_requests_queue_idx").on(table.status, table.createdAt),
]);

export const platformSettings = pgTable("platform_settings", {
  settingKey: text("setting_key").primaryKey(),
  settingValue: jsonb("setting_value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: createdAt(),
}, (table) => [index("audit_events_target_idx").on(table.targetType, table.targetId, table.createdAt)]);

export const newsPosts = pgTable("news_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  titleAm: text("title_am"),
  summary: text("summary").notNull(),
  body: text("body").notNull(),
  category: text("category").notNull(),
  kind: text("kind").notNull().default("News"),
  source: text("source").notNull().default("ANKUARU"),
  imageUrl: text("image_url"),
  featured: boolean("featured").notNull().default(false),
  status: text("status").notNull().default("Draft"),
  createdBy: text("created_by").notNull().references(() => traders.id),
  submittedBy: text("submitted_by").references(() => traders.id),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  check("news_posts_category_check", sql`${table.category} in ('Market', 'Origins', 'Platform', 'Export', 'Policy')`),
  check("news_posts_kind_check", sql`${table.kind} in ('News', 'Tender', 'Event')`),
  check("news_posts_status_check", sql`${table.status} in ('Draft', 'Pending Review', 'Published', 'Rejected')`),
  check("news_posts_submission_kind_check", sql`${table.submittedBy} is null or ${table.kind} in ('Tender', 'Event')`),
  check("news_posts_published_at_check", sql`${table.status} <> 'Published' or ${table.publishedAt} is not null`),
  index("news_posts_public_idx").on(table.status, table.publishedAt),
  index("news_posts_submitter_idx").on(table.submittedBy, table.createdAt, table.id),
]);

export const exchangeRates = pgTable("exchange_rates", {
  id: uuid("id").primaryKey().defaultRandom(),
  baseCurrency: text("base_currency").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  rate: numeric("rate", { precision: 20, scale: 8 }).notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  createdBy: text("created_by").notNull().references(() => traders.id),
  createdAt: createdAt(),
}, (table) => [
  check("exchange_rates_currency_check", sql`${table.baseCurrency} ~ '^[A-Z]{3}$' and ${table.quoteCurrency} ~ '^[A-Z]{3}$' and ${table.baseCurrency} <> ${table.quoteCurrency}`),
  check("exchange_rates_positive_check", sql`${table.rate} > 0`),
  index("exchange_rates_pair_effective_idx").on(table.baseCurrency, table.quoteCurrency, table.effectiveAt),
]);

/** One view or share of a news post; `visitor` is an anonymous browser id. */
export const newsPostEvents = pgTable("news_post_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  postId: uuid("post_id").notNull().references(() => newsPosts.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  visitor: text("visitor").notNull(),
  readSeconds: integer("read_seconds"),
  createdAt: createdAt(),
}, (table) => [
  check("news_post_events_kind_check", sql`${table.kind} in ('view', 'share')`),
  index("news_post_events_post_idx").on(table.postId, table.kind, table.createdAt),
]);

/** A reference market price for one product, on one market and day. */
export const marketPrices = pgTable("market_prices", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: text("product_id").notNull().references(() => catalogProducts.id),
  price: numeric("price").notNull(),
  currency: text("currency").notNull().default("ETB"),
  market: text("market").notNull(),
  priceDate: date("price_date").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
}, (table) => [
  check("market_prices_currency_check", sql`${table.currency} in ('ETB', 'USD')`),
  index("market_prices_product_idx").on(table.productId, table.priceDate),
]);

/** A guide, report, regulation or video for traders. */
export const resources = pgTable("resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  categoryId: text("category_id").notNull().default("all"),
  summary: text("summary").notNull(),
  body: text("body").notNull().default(""),
  link: text("link").notNull().default(""),
  status: text("status").notNull().default("Draft"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  check("resources_type_check", sql`${table.type} in ('Guide', 'Report', 'Regulation', 'Video')`),
  check("resources_status_check", sql`${table.status} in ('Draft', 'Published')`),
  index("resources_status_idx").on(table.status, table.createdAt),
]);
