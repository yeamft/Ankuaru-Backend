import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { newsPosts } from "./admin.js";
import { traders } from "./identity.js";
import { listings } from "./marketplace.js";

export const legacyUsers = pgTable("legacy_users", {
  sourceId: text("source_id").primaryKey(),
  traderId: text("trader_id").notNull().unique().references(() => traders.id),
  chatId: text("chat_id"),
  claimPhone: text("claim_phone"),
  claimBlocked: boolean("claim_blocked").notNull().default(false),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  cutoverAt: timestamp("cutover_at", { withTimezone: true }),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("legacy_users_claim_phone_idx").on(table.claimPhone),
  uniqueIndex("legacy_users_unclaimed_phone_unique_idx")
    .on(table.claimPhone)
    .where(sql`${table.claimPhone} is not null and ${table.claimBlocked} = false and ${table.claimedAt} is null`),
]);

export const legacyListingImports = pgTable("legacy_listing_imports", {
  sourceKey: text("source_key").primaryKey(),
  listingId: text("listing_id").unique().references(() => listings.id, { onDelete: "set null" }),
  sourceUserId: text("source_user_id").notNull().references(() => legacyUsers.sourceId),
  snapshot: jsonb("snapshot").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const legacyNewsImports = pgTable("legacy_news_imports", {
  sourceId: text("source_id").primaryKey(),
  newsPostId: uuid("news_post_id").unique().references(() => newsPosts.id, { onDelete: "set null" }),
  snapshot: jsonb("snapshot").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});
