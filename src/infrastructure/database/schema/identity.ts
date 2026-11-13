import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.js";

export const traders = pgTable("traders", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  businessName: text("business_name"),
  phone: text("phone").unique(),
  city: text("city"),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  verificationTier: text("verification_tier").notNull().default("registered"),
  role: text("role").notNull().default("both"),
  verified: boolean("verified").notNull().default(false),
  status: text("status").notNull().default("Pending"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  check("traders_role_check", sql`${table.role} in ('buyer', 'seller', 'both')`),
  check("traders_status_check", sql`${table.status} in ('Active', 'Pending', 'Suspended')`),
  check("traders_verification_tier_check", sql`${table.verificationTier} in ('registered', 'individual', 'business')`),
]);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey().references(() => traders.id, { onDelete: "cascade" }),
  /** Null, with the password, for accounts that sign in with Telegram only. */
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  accountRole: text("account_role").notNull().default("user"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [
  check("accounts_email_check", sql`${table.email} = lower(btrim(${table.email}))`),
  check("accounts_email_password_check", sql`(${table.email} is null) = (${table.passwordHash} is null)`),
  check("accounts_account_role_check", sql`${table.accountRole} in ('user', 'moderator', 'content_manager', 'platform_admin', 'super_admin')`),
]);

/** A Telegram user who signs in to an account (one each way). */
export const telegramIdentities = pgTable("telegram_identities", {
  telegramId: text("telegram_id").primaryKey(),
  accountId: text("account_id").notNull().unique().references(() => accounts.id, { onDelete: "cascade" }),
  username: text("username"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accountSessions = pgTable("account_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  index("account_sessions_account_idx").on(table.accountId),
  index("account_sessions_expiry_idx").on(table.expiresAt),
]);

export const authRateLimits = pgTable("auth_rate_limits", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("auth_rate_limits_expiry_idx").on(table.expiresAt)]);

export const phoneOtpCodes = pgTable("phone_otp_codes", {
  phone: text("phone").primaryKey(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("phone_otp_attempts_check", sql`${table.attempts} between 0 and 5`),
  index("phone_otp_expiry_idx").on(table.expiresAt),
]);

/** Permissions held by each configurable staff role; super admins hold all of them. */
export const rolePermissions = pgTable("role_permissions", {
  role: text("role").notNull(),
  permission: text("permission").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.role, table.permission] }),
  check("role_permissions_role_check", sql`${table.role} in ('moderator', 'content_manager', 'platform_admin')`),
]);
