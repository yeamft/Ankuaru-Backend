import { and, desc, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../../../infrastructure/database/db.js";
import {
  accounts,
  accountSessions,
  auditEvents,
  inquiries,
  legacyUsers,
  listings,
  telegramIdentities,
  traders,
  verificationRequests,
} from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";

/**
 * Everything staff need about one trader in one place: profile and account,
 * sign-in methods, imported profile, listings, inquiries, KYC and staff actions.
 */
export async function userOverview(database: Database, traderId: string) {
  const [profile] = await database
    .select({
      id: traders.id,
      display_name: traders.displayName,
      business_name: traders.businessName,
      phone: traders.phone,
      phone_verified: traders.phoneVerified,
      city: traders.city,
      role: traders.role,
      status: traders.status,
      verified: traders.verified,
      verification_tier: traders.verificationTier,
      created_at: traders.createdAt,
      email: accounts.email,
      account_role: accounts.accountRole,
      has_account: sql<boolean>`${accounts.id} is not null`,
      account_created_at: accounts.createdAt,
      last_sign_in_at: sql<Date | null>`(select max(${accountSessions.createdAt}) from ${accountSessions} where ${accountSessions.accountId} = ${traders.id})`,
      telegram_username: telegramIdentities.username,
      has_telegram: sql<boolean>`${telegramIdentities.telegramId} is not null`,
    })
    .from(traders)
    .leftJoin(accounts, eq(accounts.id, traders.id))
    .leftJoin(telegramIdentities, eq(telegramIdentities.accountId, traders.id))
    .where(eq(traders.id, traderId));
  if (!profile) throw new ApiError(404, "user_not_found", "User not found.");

  const counterpart = alias(traders, "counterpart");
  const [legacy, recentListings, listingCounts, recentInquiries, inquiryCounts, kyc, actions] =
    await Promise.all([
      database
        .select({
          source_id: legacyUsers.sourceId,
          claimed_at: legacyUsers.claimedAt,
          claim_phone: legacyUsers.claimPhone,
          claim_blocked: legacyUsers.claimBlocked,
          imported_at: legacyUsers.importedAt,
        })
        .from(legacyUsers)
        .where(eq(legacyUsers.traderId, traderId))
        .then((rows) => rows[0] ?? null),
      database
        .select({
          id: listings.id,
          reference: listings.reference,
          intent: listings.intent,
          product: listings.product,
          category: listings.category,
          status: listings.status,
          created_at: listings.createdAt,
        })
        .from(listings)
        .where(eq(listings.ownerId, traderId))
        .orderBy(desc(listings.createdAt))
        .limit(10),
      database
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${listings.status} in ('Active', 'Closing Soon'))::int`,
        })
        .from(listings)
        .where(eq(listings.ownerId, traderId))
        .then((rows) => rows[0] ?? { total: 0, active: 0 }),
      database
        .select({
          id: inquiries.id,
          status: inquiries.status,
          created_at: inquiries.createdAt,
          received: sql<boolean>`${inquiries.sellerId} = ${traderId}`,
          listing_reference: listings.reference,
          listing_product: listings.product,
          counterpart_name: counterpart.displayName,
        })
        .from(inquiries)
        .innerJoin(listings, eq(listings.id, inquiries.listingId))
        .leftJoin(
          counterpart,
          sql`${counterpart.id} = case when ${inquiries.sellerId} = ${traderId} then ${inquiries.buyerId} else ${inquiries.sellerId} end`,
        )
        .where(or(eq(inquiries.sellerId, traderId), eq(inquiries.buyerId, traderId)))
        .orderBy(desc(inquiries.createdAt))
        .limit(8),
      database
        .select({
          received: sql<number>`count(*) filter (where ${inquiries.sellerId} = ${traderId})::int`,
          sent: sql<number>`count(*) filter (where ${inquiries.buyerId} = ${traderId})::int`,
        })
        .from(inquiries)
        .where(or(eq(inquiries.sellerId, traderId), eq(inquiries.buyerId, traderId)))
        .then((rows) => rows[0] ?? { received: 0, sent: 0 }),
      database
        .select({
          id: verificationRequests.id,
          type: verificationRequests.verificationType,
          status: verificationRequests.status,
          created_at: verificationRequests.createdAt,
          reviewed_at: verificationRequests.reviewedAt,
        })
        .from(verificationRequests)
        .where(eq(verificationRequests.traderId, traderId))
        .orderBy(desc(verificationRequests.createdAt)),
      database
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          created_at: auditEvents.createdAt,
          actor_name: traders.displayName,
        })
        .from(auditEvents)
        .leftJoin(traders, eq(traders.id, auditEvents.actorId))
        .where(
          and(
            sql`${auditEvents.targetType} in ('trader', 'account')`,
            eq(auditEvents.targetId, traderId),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(10),
    ]);

  return {
    profile,
    legacy,
    listings: { ...listingCounts, recent: recentListings },
    inquiries: { ...inquiryCounts, recent: recentInquiries },
    verification_requests: kyc,
    staff_actions: actions,
  };
}
