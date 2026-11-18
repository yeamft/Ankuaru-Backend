import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import {
  accounts,
  inquiries,
  inquiryEvents,
  listings,
  platformSettings,
  traders,
  verificationRequests,
} from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";
import { oneOf } from "../../../shared/validation.js";
import { createListing, INQUIRY_STATUSES, isUuid } from "../../marketplace/index.js";
import { audit } from "./audit.service.js";
import { assertAdminsRemain } from "./users.service.js";
import { settingValueSchema } from "../schemas.js";

const LISTING_STATUSES = ["Active", "Closing Soon", "Flagged", "Closed", "Rejected", "Pending Review", "Draft"];
const TRADER_STATUSES = ["Active", "Pending", "Suspended"];
const SETTING_KEYS = ["marketplace", "notifications"];
/** Setting fields only a super admin may change: they can take the marketplace offline. */
const SENSITIVE_SETTING_FIELDS: Record<string, string[]> = { marketplace: ["maintenanceMode"] };
const liveStatuses = ["Active", "Closing Soon"];

function notFound(code: string, what: string): never {
  throw new ApiError(404, code, `${what} not found.`);
}

const listingProjection = {
  id: listings.id,
  owner_id: listings.ownerId,
  reference: listings.reference,
  intent: listings.intent,
  category: listings.category,
  product: listings.product,
  quantity: listings.quantity,
  price_amount: sql<number | null>`${listings.priceAmount}::double precision`,
  price_currency: listings.priceCurrency,
  available_from: sql<string | null>`${listings.availableFrom}::text`,
  description: listings.description,
  image_url: listings.imageUrl,
  region: listings.region,
  grade: listings.grade,
  process: listings.process,
  transaction_type: listings.transactionType,
  source: listings.source,
  source_reference: listings.sourceReference,
  status: listings.status,
  created_at: listings.createdAt,
  review_note: listings.reviewNote,
  reviewed_by: listings.reviewedBy,
  featured: listings.featured,
  featured_at: listings.featuredAt,
  reviewed_at: listings.reviewedAt,
  views: listings.views,
  product_name: sql<string | null>`(select cp.name from catalog_products cp where cp.id = "listings"."product_id" or (cp.category_id = "listings"."category" and cp.key = "listings"."product") limit 1)`,
};

export async function overview(database: Database) {
  const result = await database.execute(sql`SELECT
    (SELECT count(*)::int FROM ${traders}) AS traders,
    (SELECT count(*)::int FROM ${listings} WHERE ${listings.status} IN ('Active', 'Closing Soon')) AS active_listings,
    (SELECT count(*)::int FROM ${listings} WHERE ${listings.status} = 'Pending Review') AS pending_review,
    (SELECT count(*)::int FROM ${listings} WHERE ${listings.status} = 'Pending Review' AND ${listings.intent} = 'sell') AS pending_offers,
    (SELECT count(*)::int FROM ${listings} WHERE ${listings.status} = 'Pending Review' AND ${listings.intent} = 'buy') AS pending_inquiries,
    (SELECT count(*)::int FROM ${listings} WHERE ${listings.status} = 'Flagged') AS flagged,
    (SELECT count(*)::int FROM ${inquiries} WHERE ${inquiries.status} IN ('New', 'Responded')) AS open_inquiries,
    (SELECT count(*)::int FROM ${verificationRequests} WHERE ${verificationRequests.status} = 'Pending') AS pending_verifications`);
  return result.rows[0];
}

/** Listings newest first; `status` narrows them, e.g. to the "Pending Review" queue. */
export async function listListings(
  database: Database,
  page: PageRequest,
  status: string | null = null,
  intent: string | null = null,
) {
  if (status !== null) oneOf(status, LISTING_STATUSES, "invalid_listing_status");
  if (intent !== null) oneOf(intent, ["buy", "sell"], "invalid_intent");
  const cursor = page.after;
  const rows = await database.select({
    ...listingProjection,
    owner_name: sql<string>`coalesce(${traders.businessName}, ${traders.displayName})`,
    owner_verified: sql<boolean>`coalesce(${traders.verified} and ${traders.phoneVerified}, false)`,
    owner_status: traders.status,
    _k0: sql<string>`${listings.createdAt}::text`,
    _k1: listings.id,
  }).from(listings).leftJoin(traders, eq(traders.id, listings.ownerId))
    .where(and(
      status ? eq(listings.status, status) : undefined,
      intent ? eq(listings.intent, intent) : undefined,
      cursor ? or(lt(listings.createdAt, new Date(cursor[0])), and(eq(listings.createdAt, new Date(cursor[0])), lt(listings.id, cursor[1]))) : undefined,
    ))
    .orderBy(desc(listings.createdAt), desc(listings.id)).limit(page.limit + 1);
  return rows;
}

export async function updateListingStatus(database: Database, adminId: string, listingId: string, body: Record<string, unknown>) {
  const status = oneOf(body.status, LISTING_STATUSES, "invalid_listing_status");
  return transaction(database, async (tx) => {
    const [current] = await tx.select({ status: listings.status }).from(listings)
      .where(eq(listings.id, listingId)).for("update");
    if (!current) notFound("listing_not_found", "Listing");
    // Going live from review must pass the approval checks.
    if (status === "Active" && ["Pending Review", "Draft", "Rejected"].includes(current.status))
      throw new ApiError(409, "approval_required", "Approve or reject listings in review instead.");
    const [row] = await tx.update(listings).set({ status }).where(eq(listings.id, listingId))
      .returning(listingProjection);
    if (!row) notFound("listing_not_found", "Listing");
    await audit(tx, adminId, "listing.status_updated", "listing", listingId);
    return row;
  });
}

/**
 * Features or unfeatures a listing. Only live listings can be featured, so the
 * banner never points at something buyers cannot open; unfeaturing always works.
 */
export async function setListingFeatured(database: Database, adminId: string, listingId: string, body: Record<string, unknown>) {
  const parsed = z.object({ featured: z.boolean() }).safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_featured", "Send featured: true or false.");
  const { featured } = parsed.data;
  return transaction(database, async (tx) => {
    const [current] = await tx.select({ status: listings.status }).from(listings)
      .where(eq(listings.id, listingId)).for("update");
    if (!current) notFound("listing_not_found", "Listing");
    if (featured && !liveStatuses.includes(current.status))
      throw new ApiError(409, "listing_not_live", "Only live listings can be featured.");
    const [row] = await tx.update(listings)
      .set({ featured, featuredAt: featured ? new Date() : null })
      .where(eq(listings.id, listingId))
      .returning(listingProjection);
    await audit(tx, adminId, featured ? "listing.featured" : "listing.unfeatured", "listing", listingId);
    return row!;
  });
}

const onBehalfSchema = z.object({
  owner_id: z.string().trim().min(1),
  status: z.enum(["Active", "Pending Review"]).default("Pending Review"),
});

/**
 * Posts a listing for a trader, e.g. one sent by phone or at a market. It goes
 * through the same validation as the trader's own posts; staff may publish it
 * straight away when the trader is verified and allowed that listing type.
 */
export async function createListingForTrader(database: Database, adminId: string, body: Record<string, unknown>) {
  const parsed = onBehalfSchema.safeParse(body);
  if (!parsed.success) throw new ApiError(400, "invalid_listing", "Choose the trader the listing is for.");
  const { owner_id: ownerId, status } = parsed.data;
  const [owner] = await database
    .select({ status: traders.status, verified: traders.verified, phoneVerified: traders.phoneVerified })
    .from(traders)
    .where(eq(traders.id, ownerId));
  if (!owner) notFound("trader_not_found", "Trader");
  if (owner.status !== "Active") throw new ApiError(409, "trader_not_active", "That trader's account is not active.");
  if (status === "Active" && !(owner.verified && owner.phoneVerified))
    throw new ApiError(409, "owner_not_verified", "Only a verified trader's listing can go live straight away.");

  const created = await createListing(database, ownerId, body);
  return transaction(database, async (tx) => {
    const [row] = await tx
      .update(listings)
      .set({
        source: "admin",
        ...(status === "Active"
          ? { status: "Active", reviewedBy: adminId, reviewedAt: new Date() }
          : {}),
      })
      .where(eq(listings.id, created.id))
      .returning(listingProjection);
    await audit(tx, adminId, "listing.created_for_trader", "listing", created.id);
    return row!;
  });
}

/** Deletes a listing nobody has inquired about; otherwise close it to keep the history. */
export async function deleteListing(database: Database, adminId: string, listingId: string) {
  return transaction(database, async (tx) => {
    const [current] = await tx.select({ id: listings.id }).from(listings)
      .where(eq(listings.id, listingId)).for("update");
    if (!current) notFound("listing_not_found", "Listing");
    const [received] = await tx.select({ count: sql<number>`count(*)::int` }).from(inquiries)
      .where(eq(inquiries.listingId, listingId));
    if ((received?.count ?? 0) > 0)
      throw new ApiError(409, "listing_not_deletable", "Buyers have inquired about this listing. Close it instead.");
    await tx.delete(listings).where(eq(listings.id, listingId));
    await audit(tx, adminId, "listing.deleted", "listing", listingId);
    return { id: listingId, deleted: true };
  });
}

const reviewNoteSchema = z.string().trim().min(3).max(500);

/**
 * Approves a listing awaiting review, putting it on the market. The owner must
 * be a verified, active trader, and staff cannot approve their own listings.
 */
export async function approveListing(database: Database, adminId: string, listingId: string) {
  return transaction(database, async (tx) => {
    const [listing] = await tx.select({
      ownerId: listings.ownerId,
      status: listings.status,
      verified: traders.verified,
      phoneVerified: traders.phoneVerified,
      ownerStatus: traders.status,
    }).from(listings).leftJoin(traders, eq(traders.id, listings.ownerId))
      .where(eq(listings.id, listingId)).for("update", { of: listings });
    if (!listing) notFound("listing_not_found", "Listing");
    if (listing.ownerId === adminId)
      throw new ApiError(403, "cannot_review_own_listing", "Another staff member must review your own listing.");
    if (listing.status !== "Pending Review" && listing.status !== "Flagged")
      throw new ApiError(409, "listing_not_in_review", "Only listings awaiting review can be approved.");
    if (!listing.verified || !listing.phoneVerified || listing.ownerStatus !== "Active")
      throw new ApiError(409, "owner_not_verified", "The trader must be verified and active before this listing can go live.");
    const [row] = await tx.update(listings)
      .set({ status: "Active", reviewNote: null, reviewedBy: adminId, reviewedAt: new Date() })
      .where(eq(listings.id, listingId)).returning(listingProjection);
    await audit(tx, adminId, "listing.approved", "listing", listingId);
    return row!;
  });
}

/** Rejects a listing awaiting review; the reason is shown to its owner, who can resubmit. */
export async function rejectListing(database: Database, adminId: string, listingId: string, body: Record<string, unknown>) {
  const reason = reviewNoteSchema.safeParse(body.reason);
  if (!reason.success)
    throw new ApiError(400, "invalid_review_note", "Give the trader a reason of 3 to 500 characters.");
  return transaction(database, async (tx) => {
    const [listing] = await tx.select({ ownerId: listings.ownerId, status: listings.status }).from(listings)
      .where(eq(listings.id, listingId)).for("update");
    if (!listing) notFound("listing_not_found", "Listing");
    if (listing.ownerId === adminId)
      throw new ApiError(403, "cannot_review_own_listing", "Another staff member must review your own listing.");
    if (listing.status !== "Pending Review" && listing.status !== "Flagged")
      throw new ApiError(409, "listing_not_in_review", "Only listings awaiting review can be rejected.");
    const [row] = await tx.update(listings)
      .set({ status: "Rejected", reviewNote: reason.data, reviewedBy: adminId, reviewedAt: new Date() })
      .where(eq(listings.id, listingId)).returning(listingProjection);
    await audit(tx, adminId, "listing.rejected", "listing", listingId);
    return row!;
  });
}

const traderStats = databaseTraderStats();
function databaseTraderStats() {
  return {
    active_listings: sql<number>`count(${listings.id}) filter (where ${listings.status} in ('Active', 'Closing Soon'))::int`,
    last_active: sql<Date>`greatest(${traders.updatedAt}, coalesce(max(${listings.createdAt}), ${traders.updatedAt}))`,
  };
}

export async function listTraders(database: Database, page: PageRequest) {
  const inner = database.select({
    id: traders.id,
    display_name: sql<string>`coalesce(${traders.businessName}, ${traders.displayName})`,
    role: traders.role,
    verified: traders.verified,
    status: traders.status,
    ...traderStats,
  }).from(traders).leftJoin(listings, eq(listings.ownerId, traders.id)).groupBy(traders.id).as("trader_stats");
  const cursor = page.after;
  return database.select({
    id: inner.id,
    display_name: inner.display_name,
    role: inner.role,
    verified: inner.verified,
    status: inner.status,
    active_listings: inner.active_listings,
    last_active: inner.last_active,
    _k0: sql<string>`${inner.last_active}::text`,
    _k1: inner.id,
  }).from(inner)
    .where(cursor ? or(lt(inner.last_active, new Date(cursor[0])), and(eq(inner.last_active, new Date(cursor[0])), lt(inner.id, cursor[1]))) : undefined)
    .orderBy(desc(inner.last_active), desc(inner.id)).limit(page.limit + 1);
}

export async function updateTrader(
  database: Database,
  adminId: string,
  traderId: string,
  body: Record<string, unknown>,
  { canManageStaff = true }: { canManageStaff?: boolean } = {},
) {
  const requested = body.status ?? null;
  const verifiedResult = z.boolean().nullable().optional().safeParse(body.verified);
  if (!verifiedResult.success) throw new ApiError(400, "invalid_trader_verified", "verified must be true or false.");
  const verified = verifiedResult.data ?? null;
  if (requested === null && verified === null) throw new ApiError(400, "empty_trader_update", "Provide a status or verification flag.");
  const status = requested === null ? null : oneOf(requested, TRADER_STATUSES, "invalid_trader_status");
  return transaction(database, async (tx) => {
    if (!canManageStaff) {
      const [target] = await tx.select({ accountRole: accounts.accountRole }).from(accounts)
        .where(eq(accounts.id, traderId));
      if (target && target.accountRole !== "user") {
        throw new ApiError(403, "permission_denied", "Only a super admin can change staff accounts.");
      }
    }
    if (status && status !== "Active") {
      if (traderId === adminId) throw new ApiError(400, "cannot_suspend_self", "You cannot change your own account status.");
      await assertAdminsRemain(tx, traderId);
    }
    const [updated] = await tx.update(traders).set({
      ...(status === null ? {} : { status }),
      ...(verified === null ? {} : {
        verified,
        verificationTier: verified
          ? sql`case when ${traders.verificationTier} = 'registered' then 'individual' else ${traders.verificationTier} end`
          : "registered",
      }),
      updatedAt: new Date(),
    }).where(eq(traders.id, traderId)).returning();
    if (!updated) notFound("trader_not_found", "Trader");
    const [row] = await tx.select({
      id: traders.id,
      display_name: sql<string>`coalesce(${traders.businessName}, ${traders.displayName})`,
      role: traders.role,
      verified: traders.verified,
      status: traders.status,
      active_listings: traderStats.active_listings,
      last_active: traderStats.last_active,
    }).from(traders).leftJoin(listings, eq(listings.ownerId, traders.id))
      .where(eq(traders.id, traderId)).groupBy(traders.id);
    await audit(tx, adminId, "trader.updated", "trader", traderId);
    return row;
  });
}

export async function listVerifications(database: Database, page: PageRequest) {
  const rank = sql<number>`case when ${verificationRequests.status} = 'Pending' then 0 else 1 end`;
  const cursor = page.after;
  return database.select({
    id: verificationRequests.id,
    trader_id: verificationRequests.traderId,
    trader_name: traders.displayName,
    verification_type: verificationRequests.verificationType,
    details: verificationRequests.details,
    document_summary: verificationRequests.documentSummary,
    status: verificationRequests.status,
    created_at: verificationRequests.createdAt,
    _rank: rank,
    _k0: sql<string>`${rank}::text`,
    _k1: sql<string>`${verificationRequests.createdAt}::text`,
    _k2: sql<string>`${verificationRequests.id}::text`,
  }).from(verificationRequests).innerJoin(traders, eq(traders.id, verificationRequests.traderId))
    .where(cursor ? or(gt(rank, Number(cursor[0])), and(eq(rank, Number(cursor[0])), lt(verificationRequests.createdAt, new Date(cursor[1]))), and(eq(rank, Number(cursor[0])), eq(verificationRequests.createdAt, new Date(cursor[1])), lt(verificationRequests.id, cursor[2]))) : undefined)
    .orderBy(asc(rank), desc(verificationRequests.createdAt), desc(verificationRequests.id)).limit(page.limit + 1)
    .then((rows) => rows.map(({ _rank: _, ...row }) => row));
}

export async function reviewVerification(database: Database, adminId: string, verificationId: string, body: Record<string, unknown>) {
  if (!isUuid(verificationId)) throw new ApiError(400, "invalid_verification_id", "Verification ID is not valid.");
  const decision = oneOf(body.status, ["Approved", "Declined"], "invalid_verification_status");
  return transaction(database, async (tx) => {
    const [reviewed] = await tx.update(verificationRequests).set({ status: decision, reviewedBy: adminId, reviewedAt: new Date() })
      .where(and(eq(verificationRequests.id, verificationId), eq(verificationRequests.status, "Pending")))
      .returning({
        traderId: verificationRequests.traderId,
        verificationType: verificationRequests.verificationType,
        details: verificationRequests.details,
      });
    if (!reviewed) notFound("verification_not_found", "Pending verification");
    if (decision === "Approved") {
      await tx.update(traders).set({
        verified: true,
        verificationTier: reviewed.verificationType,
        ...(reviewed.verificationType === "business" && typeof reviewed.details === "object" && reviewed.details !== null && "business_name" in reviewed.details
          ? { businessName: String(reviewed.details.business_name) }
          : {}),
        status: sql`case when ${traders.status} = 'Pending' then 'Active' else ${traders.status} end`,
        updatedAt: new Date(),
      }).where(eq(traders.id, reviewed.traderId));
    }
    const [row] = await tx.select({
      id: verificationRequests.id,
      trader_id: verificationRequests.traderId,
      trader_name: traders.displayName,
      verification_type: verificationRequests.verificationType,
      details: verificationRequests.details,
      document_summary: verificationRequests.documentSummary,
      status: verificationRequests.status,
      created_at: verificationRequests.createdAt,
    }).from(verificationRequests).innerJoin(traders, eq(traders.id, verificationRequests.traderId))
      .where(eq(verificationRequests.id, verificationId));
    await audit(tx, adminId, "verification.reviewed", "verification", verificationId);
    return row;
  });
}

export async function listInquiries(database: Database, page: PageRequest) {
  const cursor = page.after;
  return database.select({
    id: inquiries.id,
    listing_reference: listings.reference,
    buyer_id: inquiries.buyerId,
    seller_id: inquiries.sellerId,
    status: inquiries.status,
    received_at: inquiries.createdAt,
    _k0: sql<string>`${inquiries.createdAt}::text`,
    _k1: sql<string>`${inquiries.id}::text`,
  }).from(inquiries).innerJoin(listings, eq(listings.id, inquiries.listingId))
    .where(cursor ? or(lt(inquiries.createdAt, new Date(cursor[0])), and(eq(inquiries.createdAt, new Date(cursor[0])), lt(inquiries.id, cursor[1]))) : undefined)
    .orderBy(desc(inquiries.createdAt), desc(inquiries.id)).limit(page.limit + 1);
}

export async function updateInquiryStatus(database: Database, adminId: string, inquiryId: string, body: Record<string, unknown>) {
  if (!isUuid(inquiryId)) throw new ApiError(400, "invalid_inquiry_id", "Inquiry ID is not valid.");
  const status = oneOf(body.status, INQUIRY_STATUSES, "invalid_inquiry_status");
  return transaction(database, async (tx) => {
    const [previous] = await tx.select({ status: inquiries.status }).from(inquiries)
      .where(eq(inquiries.id, inquiryId)).for("update");
    const [row] = await tx.update(inquiries).set({ status }).where(eq(inquiries.id, inquiryId)).returning({
      id: inquiries.id, listing_id: inquiries.listingId, buyer_id: inquiries.buyerId,
      seller_id: inquiries.sellerId, message: inquiries.message, status: inquiries.status,
      created_at: inquiries.createdAt,
    });
    if (!row) notFound("inquiry_not_found", "Inquiry");
    if (previous && previous.status !== status) {
      await tx.insert(inquiryEvents).values({
        inquiryId, actorId: adminId, kind: "status_changed", fromStatus: previous.status, toStatus: status,
      });
    }
    await audit(tx, adminId, "inquiry.status_updated", "inquiry", inquiryId);
    return row;
  });
}

export async function listSettings(database: Database) {
  return database.select({ setting_key: platformSettings.settingKey, setting_value: platformSettings.settingValue, updated_at: platformSettings.updatedAt })
    .from(platformSettings).orderBy(asc(platformSettings.settingKey));
}

export async function updateSetting(
  database: Database,
  adminId: string,
  key: string,
  body: Record<string, unknown>,
  { canChangeSensitive = true }: { canChangeSensitive?: boolean } = {},
) {
  const parsedValue = settingValueSchema.safeParse(body.value);
  if (!SETTING_KEYS.includes(key) || !parsedValue.success) throw new ApiError(400, "invalid_setting", "Provide a JSON object for a known setting.");
  const value = parsedValue.data;
  return transaction(database, async (tx) => {
    const sensitive = SENSITIVE_SETTING_FIELDS[key] ?? [];
    if (!canChangeSensitive && sensitive.length) {
      const [current] = await tx.select({ value: platformSettings.settingValue }).from(platformSettings)
        .where(eq(platformSettings.settingKey, key)).for("update");
      const before = (current?.value ?? {}) as Record<string, unknown>;
      const changed = sensitive.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(value[field]));
      if (changed.length) {
        throw new ApiError(403, "permission_denied", `Only a super admin can change ${changed.join(", ")}.`);
      }
    }
    const [row] = await tx.update(platformSettings).set({ settingValue: value, updatedBy: adminId, updatedAt: new Date() })
      .where(eq(platformSettings.settingKey, key)).returning({
        setting_key: platformSettings.settingKey, setting_value: platformSettings.settingValue, updated_at: platformSettings.updatedAt,
      });
    if (!row) notFound("setting_not_found", "Setting");
    await audit(tx, adminId, "setting.updated", "setting", key);
    return row;
  });
}
