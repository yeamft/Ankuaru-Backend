import { and, eq, ilike, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { inquiries, inquiryEvents, listings, traders } from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";

const filtersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  kind: z.enum(["contacted", "status_changed"]).optional(),
  trader: z.string().trim().max(100).optional(),
});

export type InteractionFilters = {
  query: string | null;
  kind: "contacted" | "status_changed" | null;
  /** Only interactions this trader took part in. */
  trader: string | null;
};

/** Reads ?q=, ?kind= and ?trader= for the interaction log. */
export function interactionFilters(query: Record<string, unknown>): InteractionFilters {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const parsed = filtersSchema.safeParse({ q: text(query.q), kind: text(query.kind), trader: text(query.trader) });
  if (!parsed.success) throw new ApiError(400, "invalid_query", "Choose a valid filter or a shorter search.");
  return { query: parsed.data.q ?? null, kind: parsed.data.kind ?? null, trader: parsed.data.trader ?? null };
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Trader-to-trader interactions, newest first: who contacted whom about which
 * listing, and each status change after. Message text stays private.
 */
export async function listInteractions(database: Database, filters: InteractionFilters, page: PageRequest) {
  const actor = alias(traders, "actor");
  const buyer = alias(traders, "buyer");
  const seller = alias(traders, "seller");
  const name = (table: { businessName: AnyColumn; displayName: AnyColumn }) => sql<string | null>`coalesce(${table.businessName}, ${table.displayName})`;
  // The other side of the conversation from whoever acted (null when staff acted).
  const counterpartId = sql<string | null>`case
    when ${inquiryEvents.actorId} = ${inquiries.buyerId} then ${inquiries.sellerId}
    when ${inquiryEvents.actorId} = ${inquiries.sellerId} then ${inquiries.buyerId}
  end`;
  const counterpartName = sql<string | null>`case
    when ${inquiryEvents.actorId} = ${inquiries.buyerId} then ${name(seller)}
    when ${inquiryEvents.actorId} = ${inquiries.sellerId} then ${name(buyer)}
  end`;
  const cursor = page.after;
  const conditions: (SQL | undefined)[] = [
    filters.kind ? eq(inquiryEvents.kind, filters.kind) : undefined,
    filters.trader ? or(eq(inquiries.buyerId, filters.trader), eq(inquiries.sellerId, filters.trader)) : undefined,
    filters.query
      ? or(
          ilike(name(buyer), likePattern(filters.query)),
          ilike(name(seller), likePattern(filters.query)),
          ilike(buyer.phone, likePattern(filters.query)),
          ilike(seller.phone, likePattern(filters.query)),
          ilike(listings.reference, likePattern(filters.query)),
          ilike(listings.product, likePattern(filters.query)),
        )
      : undefined,
    cursor
      ? sql`(${inquiryEvents.createdAt}, ${inquiryEvents.id}) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
      : undefined,
  ];
  return database
    .select({
      id: inquiryEvents.id,
      kind: inquiryEvents.kind,
      from_status: inquiryEvents.fromStatus,
      to_status: inquiryEvents.toStatus,
      created_at: inquiryEvents.createdAt,
      inquiry_id: inquiries.id,
      current_status: inquiries.status,
      actor_id: inquiryEvents.actorId,
      actor_name: name(actor),
      actor_phone: actor.phone,
      /** True when a staff member (not one of the two traders) changed the status. */
      by_staff: sql<boolean>`${inquiryEvents.actorId} not in (${inquiries.buyerId}, ${inquiries.sellerId})`,
      counterpart_id: counterpartId,
      counterpart_name: counterpartName,
      counterpart_phone: sql<string | null>`case
        when ${inquiryEvents.actorId} = ${inquiries.buyerId} then ${seller.phone}
        when ${inquiryEvents.actorId} = ${inquiries.sellerId} then ${buyer.phone}
      end`,
      buyer_id: inquiries.buyerId,
      buyer_name: name(buyer),
      seller_id: inquiries.sellerId,
      seller_name: name(seller),
      listing_id: listings.id,
      listing_reference: listings.reference,
      listing_product: listings.product,
      listing_intent: listings.intent,
      _k0: sql<string>`${inquiryEvents.createdAt}::text`,
      _k1: sql<string>`${inquiryEvents.id}::text`,
    })
    .from(inquiryEvents)
    .innerJoin(inquiries, eq(inquiries.id, inquiryEvents.inquiryId))
    .innerJoin(listings, eq(listings.id, inquiries.listingId))
    .leftJoin(actor, eq(actor.id, inquiryEvents.actorId))
    .leftJoin(buyer, eq(buyer.id, inquiries.buyerId))
    .leftJoin(seller, eq(seller.id, inquiries.sellerId))
    .where(and(...conditions))
    .orderBy(sql`${inquiryEvents.createdAt} desc, ${inquiryEvents.id} desc`)
    .limit(page.limit + 1);
}
