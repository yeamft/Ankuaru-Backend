import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { createDatabase, type Database } from "../../infrastructure/database/index.js";
import { accounts, accountSessions, authRateLimits, legacyUsers, phoneOtpCodes, traders, userPreferences } from "../../infrastructure/database/schema.js";
import { transaction, type DatabaseTransaction } from "../../infrastructure/database/transaction.js";
import { isUniqueViolation } from "../../shared/db-errors.js";
import { ApiError } from "../../shared/errors.js";
import type { AccountRole } from "./permissions.js";
import type { TRADER_STATUSES } from "./schemas.js";

export type Account = {
  id: string;
  /** Null for trader accounts, which sign in with a phone code. */
  email: string | null;
  display_name: string;
  business_name: string | null;
  phone: string | null;
  city: string | null;
  phone_verified: boolean;
  verification_tier: "registered" | "individual" | "business";
  role: "buyer" | "seller" | "both";
  account_role: AccountRole;
  verified: boolean;
  status: (typeof TRADER_STATUSES)[number];
  /** Whether the trader has set a sign-in PIN yet. */
  has_pin: boolean;
};
export type Credentials = Account & { password_hash: string };
export type Registration = Pick<Account, "email" | "display_name" | "role"> & {
  phone: string;
  city: string | null;
};
export type ProfileUpdate = Partial<Pick<Account, "display_name" | "role" | "city">>;
export type NewSession = { tokenHash: string; expiresAt: Date };
export type Preferences = {
  language: "en" | "am";
  currency: "USD" | "ETB";
  notify_inquiries: boolean;
  notify_listing_updates: boolean;
  notify_market_news: boolean;
};
export const DEFAULT_PREFERENCES: Preferences = {
  language: "en",
  currency: "USD",
  notify_inquiries: true,
  notify_listing_updates: true,
  notify_market_news: false,
};
/** An imported legacy profile that registering with its phone number will claim. */
export type ClaimableProfile = { display_name: string; business_name: string | null; city: string | null };
/** What a PIN sign-in needs to know about the account behind a phone number. */
export type PinCredentials = {
  id: string;
  status: Account["status"];
  account_role: AccountRole;
  pin_hash: string | null;
  pin_failed_attempts: number;
};
/** Outcome of starting a session for the trader who owns a verified phone number. */
export type PhoneSessionResult = "signed_in" | "inactive" | "none";

export interface AuthStore {
  /** `passwordHash` is null for phone-only trader accounts (no email either). */
  register(input: Registration, passwordHash: string | null, session: NewSession): Promise<Account | null>;
  /** Starts a session for the account whose trader profile uses this (already verified) phone. */
  createPhoneSession(phone: string, session: NewSession): Promise<PhoneSessionResult>;
  /** The account behind a phone number, for PIN sign-in; null when there is none. */
  pinCredentials(phone: string): Promise<PinCredentials | null>;
  /** Counts a wrong PIN and returns the new total. */
  recordPinFailure(accountId: string): Promise<number>;
  /** Starts a session if the PIN is still `expectedPinHash` and the trader is active. */
  createPinSession(accountId: string, expectedPinHash: string, session: NewSession): Promise<boolean>;
  setPin(accountId: string, pinHash: string): Promise<boolean>;
  createPhoneOtp(phone: string, codeHash: string, expiresAt: Date): Promise<boolean>;
  deletePhoneOtp(phone: string): Promise<void>;
  consumePhoneOtp(phone: string, codeHash: string): Promise<boolean>;
  findClaimableProfile(phone: string): Promise<ClaimableProfile | null>;
  verifyPhoneForAccount(accountId: string, phone: string, codeHash: string): Promise<boolean>;
  credentials(email: string): Promise<Credentials | null>;
  createSession(accountId: string, expectedHash: string, session: NewSession): Promise<boolean>;
  resolveSession(tokenHash: string): Promise<Account | null>;
  revokeSession(tokenHash: string): Promise<void>;
  updateProfile(accountId: string, input: ProfileUpdate): Promise<Account | null>;
  changePassword(accountId: string, expectedHash: string, passwordHash: string): Promise<boolean>;
  consumeRateLimit(key: string): Promise<boolean>;
  preferences(accountId: string): Promise<Preferences>;
  updatePreferences(accountId: string, input: Partial<Preferences>): Promise<Preferences>;
}

const preferenceSelection = {
  language: userPreferences.language,
  currency: userPreferences.currency,
  notify_inquiries: userPreferences.notifyInquiries,
  notify_listing_updates: userPreferences.notifyListingUpdates,
  notify_market_news: userPreferences.notifyMarketNews,
};

const accountSelection = {
  id: accounts.id,
  email: accounts.email,
  display_name: traders.displayName,
  business_name: traders.businessName,
  phone: traders.phone,
  city: traders.city,
  phone_verified: traders.phoneVerified,
  verification_tier: traders.verificationTier,
  role: traders.role,
  account_role: accounts.accountRole,
  verified: traders.verified,
  status: traders.status,
  has_pin: sql<boolean>`${accounts.pinHash} is not null`,
};

export class PostgresAuthStore implements AuthStore {
  private readonly database: Database;

  constructor(pool: Pool) {
    this.database = createDatabase(pool);
  }

  async register(input: Registration, passwordHash: string | null, session: NewSession) {
    try {
      return await transaction(this.database, async (tx) => {
        const claims = await tx.select({
          sourceId: legacyUsers.sourceId,
          traderId: legacyUsers.traderId,
        }).from(legacyUsers)
          .where(and(
            eq(legacyUsers.claimPhone, input.phone),
            eq(legacyUsers.claimBlocked, false),
            isNull(legacyUsers.claimedAt),
          ))
          .limit(2)
          .for("update");
        const claim = claims.length === 1 ? claims[0] : undefined;
        const id = claim?.traderId ?? `usr_${randomUUID()}`;
        if (claim) {
          const [profile] = await tx.select({ status: traders.status, city: traders.city }).from(traders)
            .where(eq(traders.id, id)).for("update");
          if (profile?.status !== "Active") {
            throw new ApiError(409, "legacy_profile_unavailable", "The existing profile for this phone number cannot be claimed. Contact support.");
          }
          // Keep the imported name and business; fill in only what the legacy profile lacks.
          await tx.update(traders).set({
            phone: input.phone,
            phoneVerified: true,
            role: input.role,
            ...(profile.city || !input.city ? {} : { city: input.city }),
            updatedAt: new Date(),
          }).where(eq(traders.id, id));
        } else {
          await tx.insert(traders).values({
            id,
            displayName: input.display_name,
            phone: input.phone,
            city: input.city,
            phoneVerified: true,
            verificationTier: "registered",
            role: input.role,
            status: "Active",
          });
        }
        await tx.insert(accounts).values({ id, email: input.email, passwordHash });
        await tx.insert(accountSessions).values({ tokenHash: session.tokenHash, accountId: id, expiresAt: session.expiresAt });
        if (claim) {
          await tx.update(legacyUsers).set({ claimedAt: new Date() })
            .where(and(eq(legacyUsers.sourceId, claim.sourceId), isNull(legacyUsers.claimedAt)));
        }
        const [profile] = await tx.select({
          displayName: traders.displayName,
          businessName: traders.businessName,
          phone: traders.phone,
          city: traders.city,
          phoneVerified: traders.phoneVerified,
          verificationTier: traders.verificationTier,
          role: traders.role,
          verified: traders.verified,
          status: traders.status,
        }).from(traders).where(eq(traders.id, id));
        return {
          id,
          email: input.email,
          display_name: profile.displayName,
          business_name: profile.businessName,
          phone: profile.phone,
          city: profile.city,
          phone_verified: profile.phoneVerified,
          verification_tier: profile.verificationTier,
          role: profile.role,
          account_role: "user",
          verified: profile.verified,
          status: profile.status,
          has_pin: false,
        } as Account;
      });
    } catch (error) {
      if (isUniqueViolation(error, ["accounts_email_key", "accounts_pkey", "traders_phone_key"])) return null;
      throw error;
    }
  }

  async createPhoneOtp(phone: string, codeHash: string, expiresAt: Date) {
    return transaction(this.database, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${phone}))`);
      const [current] = await tx.select({ sentAt: phoneOtpCodes.sentAt })
        .from(phoneOtpCodes).where(eq(phoneOtpCodes.phone, phone)).for("update");
      if (current && Date.now() - current.sentAt.getTime() < 60_000) return false;
      await tx.insert(phoneOtpCodes).values({ phone, codeHash, expiresAt, attempts: 0 })
        .onConflictDoUpdate({
          target: phoneOtpCodes.phone,
          set: { codeHash, expiresAt, attempts: 0, sentAt: new Date() },
        });
      return true;
    });
  }

  async deletePhoneOtp(phone: string) {
    await this.database.delete(phoneOtpCodes).where(eq(phoneOtpCodes.phone, phone));
  }

  /** Locks and checks the stored code, counting failed attempts. Leaves a matching code in place. */
  private async matchPhoneOtp(tx: DatabaseTransaction, phone: string, codeHash: string) {
    const [stored] = await tx.select().from(phoneOtpCodes)
      .where(eq(phoneOtpCodes.phone, phone)).for("update");
    if (!stored || stored.expiresAt <= new Date() || stored.attempts >= 5) {
      if (stored) await tx.delete(phoneOtpCodes).where(eq(phoneOtpCodes.phone, phone));
      return false;
    }
    if (stored.codeHash !== codeHash) {
      await tx.update(phoneOtpCodes).set({ attempts: stored.attempts + 1 })
        .where(eq(phoneOtpCodes.phone, phone));
      return false;
    }
    return true;
  }

  async consumePhoneOtp(phone: string, codeHash: string) {
    return transaction(this.database, async (tx) => {
      if (!(await this.matchPhoneOtp(tx, phone, codeHash))) return false;
      await tx.delete(phoneOtpCodes).where(eq(phoneOtpCodes.phone, phone));
      return true;
    });
  }

  async findClaimableProfile(phone: string): Promise<ClaimableProfile | null> {
    const rows = await this.database.select({
      display_name: traders.displayName,
      business_name: traders.businessName,
      city: traders.city,
    }).from(legacyUsers)
      .innerJoin(traders, eq(traders.id, legacyUsers.traderId))
      .where(and(
        eq(legacyUsers.claimPhone, phone),
        eq(legacyUsers.claimBlocked, false),
        isNull(legacyUsers.claimedAt),
        eq(traders.status, "Active"),
      ))
      .limit(2);
    return rows.length === 1 ? rows[0]! : null;
  }

  async verifyPhoneForAccount(accountId: string, phone: string, codeHash: string) {
    return transaction(this.database, async (tx) => {
      if (!(await this.matchPhoneOtp(tx, phone, codeHash))) return false;
      const [updated] = await tx.update(traders).set({
        phone,
        phoneVerified: true,
        updatedAt: new Date(),
      }).where(eq(traders.id, accountId)).returning({ id: traders.id });
      if (!updated) return false;
      await tx.delete(phoneOtpCodes).where(eq(phoneOtpCodes.phone, phone));
      return true;
    });
  }

  async credentials(email: string): Promise<Credentials | null> {
    const [row] = await this.database.select({ ...accountSelection, password_hash: accounts.passwordHash })
      .from(accounts).innerJoin(traders, eq(traders.id, accounts.id)).where(eq(accounts.email, email));
    return (row as Credentials | undefined) ?? null;
  }

  async createPhoneSession(phone: string, session: NewSession): Promise<PhoneSessionResult> {
    return transaction(this.database, async (tx) => {
      const [trader] = await tx.select({ id: traders.id, status: traders.status })
        .from(traders)
        .innerJoin(accounts, eq(accounts.id, traders.id))
        .where(eq(traders.phone, phone))
        .for("update");
      if (!trader) return "none";
      if (trader.status !== "Active") return "inactive";
      // A code sign-in also unlocks a PIN locked by too many wrong tries.
      await tx.update(accounts).set({ pinFailedAttempts: 0 })
        .where(and(eq(accounts.id, trader.id), gt(accounts.pinFailedAttempts, 0)));
      // The code just proved the number, so it counts as verified from now on.
      await tx.update(traders).set({ phoneVerified: true, updatedAt: new Date() })
        .where(and(eq(traders.id, trader.id), eq(traders.phoneVerified, false)));
      await tx.insert(accountSessions).values({
        tokenHash: session.tokenHash,
        accountId: trader.id,
        expiresAt: session.expiresAt,
      });
      return "signed_in";
    });
  }

  async pinCredentials(phone: string): Promise<PinCredentials | null> {
    const [row] = await this.database.select({
      id: accounts.id,
      status: traders.status,
      account_role: accounts.accountRole,
      pin_hash: accounts.pinHash,
      pin_failed_attempts: accounts.pinFailedAttempts,
    }).from(traders)
      .innerJoin(accounts, eq(accounts.id, traders.id))
      .where(eq(traders.phone, phone));
    return (row as PinCredentials | undefined) ?? null;
  }

  async recordPinFailure(accountId: string) {
    const [row] = await this.database.update(accounts)
      .set({ pinFailedAttempts: sql`${accounts.pinFailedAttempts} + 1` })
      .where(eq(accounts.id, accountId))
      .returning({ attempts: accounts.pinFailedAttempts });
    return row?.attempts ?? 0;
  }

  async createPinSession(accountId: string, expectedPinHash: string, session: NewSession) {
    return transaction(this.database, async (tx) => {
      // Lock in the same order as suspension: trader, then account.
      const [trader] = await tx.select({ id: traders.id }).from(traders)
        .where(and(eq(traders.id, accountId), eq(traders.status, "Active"))).for("update");
      if (!trader) return false;
      const [account] = await tx.update(accounts).set({ pinFailedAttempts: 0 })
        .where(and(eq(accounts.id, accountId), eq(accounts.pinHash, expectedPinHash)))
        .returning({ id: accounts.id });
      if (!account) return false;
      await tx.insert(accountSessions).values({ tokenHash: session.tokenHash, accountId, expiresAt: session.expiresAt });
      return true;
    });
  }

  async setPin(accountId: string, pinHash: string) {
    const [updated] = await this.database.update(accounts)
      .set({ pinHash, pinFailedAttempts: 0, updatedAt: new Date() })
      .where(eq(accounts.id, accountId))
      .returning({ id: accounts.id });
    return Boolean(updated);
  }

  async createSession(accountId: string, expectedHash: string, session: NewSession) {
    return transaction(this.database, async (tx) => {
      // Lock in the same order as suspension: trader, then account.
      const [trader] = await tx.select({ id: traders.id }).from(traders)
        .where(and(eq(traders.id, accountId), eq(traders.status, "Active"))).for("update");
      if (!trader) return false;
      const [account] = await tx.select({ id: accounts.id }).from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.passwordHash, expectedHash))).for("update");
      if (!account) return false;
      await tx.insert(accountSessions).values({ tokenHash: session.tokenHash, accountId, expiresAt: session.expiresAt });
      return true;
    });
  }

  async resolveSession(tokenHash: string): Promise<Account | null> {
    const [row] = await this.database.select(accountSelection).from(accountSessions)
      .innerJoin(accounts, eq(accounts.id, accountSessions.accountId))
      .innerJoin(traders, eq(traders.id, accounts.id))
      .where(and(eq(accountSessions.tokenHash, tokenHash), gt(accountSessions.expiresAt, sql`now()`), eq(traders.status, "Active")));
    return (row as Account | undefined) ?? null;
  }

  async revokeSession(tokenHash: string) {
    await this.database.delete(accountSessions).where(eq(accountSessions.tokenHash, tokenHash));
  }

  async updateProfile(accountId: string, input: ProfileUpdate): Promise<Account | null> {
    const [updated] = await this.database.update(traders).set({
      ...(input.display_name === undefined ? {} : { displayName: input.display_name }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.city === undefined ? {} : { city: input.city }),
      updatedAt: new Date(),
    }).where(and(eq(traders.id, accountId), eq(traders.status, "Active"))).returning({ id: traders.id });
    if (!updated) return null;
    const [row] = await this.database.select(accountSelection).from(accounts)
      .innerJoin(traders, eq(traders.id, accounts.id)).where(eq(accounts.id, accountId));
    return (row as Account | undefined) ?? null;
  }

  async preferences(accountId: string): Promise<Preferences> {
    const [row] = await this.database.select(preferenceSelection).from(userPreferences)
      .where(eq(userPreferences.accountId, accountId));
    return (row as Preferences | undefined) ?? { ...DEFAULT_PREFERENCES };
  }

  /** Saves the given fields; the first save fills the rest with defaults. */
  async updatePreferences(accountId: string, input: Partial<Preferences>): Promise<Preferences> {
    const changes = {
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.currency === undefined ? {} : { currency: input.currency }),
      ...(input.notify_inquiries === undefined ? {} : { notifyInquiries: input.notify_inquiries }),
      ...(input.notify_listing_updates === undefined ? {} : { notifyListingUpdates: input.notify_listing_updates }),
      ...(input.notify_market_news === undefined ? {} : { notifyMarketNews: input.notify_market_news }),
    };
    const [row] = await this.database.insert(userPreferences)
      .values({ accountId, ...changes })
      .onConflictDoUpdate({ target: userPreferences.accountId, set: { ...changes, updatedAt: new Date() } })
      .returning(preferenceSelection);
    return row as Preferences;
  }

  async changePassword(accountId: string, expectedHash: string, passwordHash: string) {
    return transaction(this.database, async (tx) => {
      const [updated] = await tx.update(accounts).set({ passwordHash, updatedAt: new Date() })
        .where(and(eq(accounts.id, accountId), eq(accounts.passwordHash, expectedHash))).returning({ id: accounts.id });
      if (!updated) return false;
      await tx.delete(accountSessions).where(eq(accountSessions.accountId, accountId));
      return true;
    });
  }

  async consumeRateLimit(key: string) {
    const [row] = await this.database.insert(authRateLimits).values({
      key,
      attempts: 1,
      expiresAt: sql`now() + interval '15 minutes'`,
    }).onConflictDoUpdate({
      target: authRateLimits.key,
      set: {
        attempts: sql`case when ${authRateLimits.expiresAt} <= now() then 1 else ${authRateLimits.attempts} + 1 end`,
        expiresAt: sql`case when ${authRateLimits.expiresAt} <= now() then now() + interval '15 minutes' else ${authRateLimits.expiresAt} end`,
      },
    }).returning({ attempts: authRateLimits.attempts });
    return row.attempts <= 30;
  }

  async cleanup() {
    await this.database.delete(accountSessions).where(lte(accountSessions.expiresAt, sql`now()`));
    await this.database.delete(authRateLimits).where(lte(authRateLimits.expiresAt, sql`now()`));
    await this.database.delete(phoneOtpCodes).where(lte(phoneOtpCodes.expiresAt, sql`now()`));
  }
}
