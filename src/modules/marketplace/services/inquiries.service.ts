import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import { inquiries, inquiryEvents, listings, traders } from "../../../infrastructure/database/schema.js";
import { transaction } from "../../../infrastructure/database/index.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";
import { isUuid } from "../../../shared/validation.js";
import { isLiveListing, type Inquiry } from "../records.js";
import { inquiryMessageSchema, inquiryStatusSchema } from "../schemas.js";
import { notifyInquiryCreated } from "./inquiry-events.service.js";

// Lets either party see what the inquiry is about and who the other side is.
export async function listUserInquiries(database: Database, userId: string, page: PageRequest) {
  const cursor = page.after;
  return database.select({
    id: inquiries.id,
    listing_id: inquiries.listingId,
    buyer_id: inquiries.buyerId,
    seller_id: inquiries.sellerId,
    message: inquiries.message,
    status: inquiries.status,
    created_at: inquiries.createdAt,
    listing_reference: listings.reference,
    listing_product: listings.product,
    buyer_name: sql<string | null>`(select coalesce(business_name, display_name) from traders where traders.id = ${inquiries.buyerId})`,
    seller_name: sql<string | null>`(select coalesce(business_name, display_name) from traders where traders.id = ${inquiries.sellerId})`,
    _k0: sql<string>`${inquiries.createdAt}::text`,
    _k1: sql<string>`${inquiries.id}::text`,
  }).from(inquiries).innerJoin(listings, eq(listings.id, inquiries.listingId))
    .where(and(
      or(eq(inquiries.buyerId, userId), eq(inquiries.sellerId, userId)),
      cursor ? or(lt(inquiries.createdAt, new Date(cursor[0])), and(eq(inquiries.createdAt, new Date(cursor[0])), lt(inquiries.id, cursor[1]))) : undefined,
    )).orderBy(desc(inquiries.createdAt), desc(inquiries.id)).limit(page.limit + 1);
}

/** Records the inquiry and notifies the seller, both in one transaction. */
export async function createInquiry(
  database: Database,
  buyerId: string,
  listingId: string,
  body: Record<string, unknown>,
): Promise<Inquiry> {
  const parsedMessage = inquiryMessageSchema.safeParse(body.message);
  if (!parsedMessage.success) throw new ApiError(400, "invalid_message", "An inquiry message is required.");
  const message = parsedMessage.data;

  return transaction(database, async (client) => {
    const [buyer] = await client.select({ verified: traders.verified, phoneVerified: traders.phoneVerified, role: traders.role }).from(traders)
      .where(eq(traders.id, buyerId));
    if (!buyer?.verified || !buyer.phoneVerified) {
      throw new ApiError(403, "verification_required", "Verify your identity and phone before contacting traders.");
    }
    const [listing] = await client.select({
      owner_id: listings.ownerId,
      intent: listings.intent,
      owner_verified: traders.verified,
      owner_phone_verified: traders.phoneVerified,
      owner_status: traders.status,
      owner_role: traders.role,
    })
      .from(listings).innerJoin(traders, eq(traders.id, listings.ownerId))
      .where(and(eq(listings.id, listingId), isLiveListing));
    const sellerId = listing?.owner_id;
    if (!sellerId) throw new ApiError(404, "listing_not_found", "Listing not found.");
    if (
      !listing.owner_verified ||
      !listing.owner_phone_verified ||
      listing.owner_status !== "Active"
    ) {
      throw new ApiError(404, "listing_not_found", "Listing not found.");
    }
    const ownerRoleMatches = listing.intent === "buy"
      ? listing.owner_role === "buyer" || listing.owner_role === "both"
      : listing.owner_role === "seller" || listing.owner_role === "both";
    if (!ownerRoleMatches) throw new ApiError(404, "listing_not_found", "Listing not found.");
    const canRespond = listing.intent === "buy"
      ? buyer.role === "seller" || buyer.role === "both"
      : buyer.role === "buyer" || buyer.role === "both";
    if (!canRespond) {
      throw new ApiError(403, "trader_role_not_allowed", "Your buyer or seller role does not allow responding to this listing.");
    }
    if (sellerId === buyerId) {
      throw new ApiError(
        400,
        "cannot_inquire_on_own_listing",
        "You cannot send an inquiry about your own listing.",
      );
    }
    const inquiryBuyerId = listing.intent === "buy" ? sellerId : buyerId;
    const inquirySellerId = listing.intent === "buy" ? buyerId : sellerId;
    const [created] = await client.insert(inquiries).values({
      listingId,
      buyerId: inquiryBuyerId,
      sellerId: inquirySellerId,
      message,
    }).returning({
      id: inquiries.id, listing_id: inquiries.listingId, buyer_id: inquiries.buyerId,
      seller_id: inquiries.sellerId, message: inquiries.message, status: inquiries.status,
      created_at: inquiries.createdAt,
    });
    // The interaction log: who contacted whom (the requester, whichever side they are on).
    await client.insert(inquiryEvents).values({
      inquiryId: created.id,
      actorId: buyerId,
      kind: "contacted",
      toStatus: created.status,
    });
    await notifyInquiryCreated(client, created);
    return created;
  });
}

/** Either party may update the status of their own inquiry. */
export async function updateInquiryStatus(
  database: Database,
  userId: string,
  inquiryId: string,
  body: Record<string, unknown>,
) {
  const [participant] = await database.select({ verified: traders.verified, phoneVerified: traders.phoneVerified })
    .from(traders).where(eq(traders.id, userId));
  if (!participant?.verified || !participant.phoneVerified) {
    throw new ApiError(403, "verification_required", "Verify your identity and phone before negotiating.");
  }
  const parsedStatus = inquiryStatusSchema.safeParse(body.status);
  if (!parsedStatus.success) {
    throw new ApiError(400, "invalid_inquiry_status", "Choose a valid inquiry status.");
  }
  const status = parsedStatus.data;
  if (!isUuid(inquiryId)) {
    throw new ApiError(400, "invalid_inquiry_id", "Inquiry ID is not valid.");
  }
  return transaction(database, async (client) => {
    const own = and(
      eq(inquiries.id, inquiryId), or(eq(inquiries.buyerId, userId), eq(inquiries.sellerId, userId)),
    );
    const [previous] = await client.select({ status: inquiries.status }).from(inquiries).where(own).for("update");
    if (!previous) throw new ApiError(404, "inquiry_not_found", "Inquiry not found.");
    const [row] = await client.update(inquiries).set({ status }).where(own).returning({
      id: inquiries.id, listing_id: inquiries.listingId, buyer_id: inquiries.buyerId,
      seller_id: inquiries.sellerId, message: inquiries.message, status: inquiries.status,
      created_at: inquiries.createdAt,
    });
    if (!row) throw new ApiError(404, "inquiry_not_found", "Inquiry not found.");
    if (previous.status !== status) {
      await client.insert(inquiryEvents).values({
        inquiryId, actorId: userId, kind: "status_changed", fromStatus: previous.status, toStatus: status,
      });
    }
    return row;
  });
}
