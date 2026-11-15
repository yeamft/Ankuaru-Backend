import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type BankForexRate = { bank: string; buying: number | null; selling: number | null };

export const bankForexSnapshots = pgTable("bank_forex_snapshots", {
  sourceId: text("source_id").primaryKey(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(),
  rates: jsonb("rates").$type<BankForexRate[]>().notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("bank_forex_latest_idx").on(table.effectiveAt, table.sourceUpdatedAt)]);
