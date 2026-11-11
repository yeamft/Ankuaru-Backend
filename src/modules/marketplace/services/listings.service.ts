import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import {
  inquiries,
  listings,
  platformSettings,
  traders,
} from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import type { PageRequest } from "../../../shared/pagination.js";
import { resolveProduct } from "../../catalog/index.js";
import { parseTelegramListing } from "./telegram-parser.js";
import {
  calendarDateSchema,
  listingCoreSchema,
  optionalTextSchema,
  priceAmountSchema,
  priceCurrencySchema,
  telegramImportSchema,
} from "../schemas.js";

export type ListingFilters = { intent: string | null; category: string | null; search: string | null };

const listingSelection = {
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
  reviewed_at: listings.reviewedAt,
  featured: listings.featured,
  // The catalog's current name for the product; listings store its key.
  product_name: sql<string | null>`(select cp.name from catalog_products cp where cp.id = "listings"."product_id" or (cp.category_id = "listings"."category" and cp.key = "listings"."product") limit 1)`,
  owner_name: sql<
    string | null
  >`(select coalesce(business_name, display_name) from traders where traders.id = ${listings.ownerId})`,
  owner_verified: sql<boolean>`coalesce((select verified from traders where traders.id = ${listings.ownerId}), false)`,
};

function invalidListing(message: string): never {
  throw new ApiError(400, "invalid_listing", message);
}

function optionalText(value: unknown, field: string, maxLength = 4000): string | null {
  const result = optionalTextSchema(maxLength).safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (issue?.code === "too_big")
      invalidListing(`${field} must be at most ${maxLength} characters.`);
    invalidListing(`${field} must be text.`);
  }
  return result.data;
}

/**
 * Where a verified trader's listing goes when submitted: straight to the market
 * if the marketplace setting autoPublishVerified is on, otherwise to staff review.
 */
async function submittedStatus(database: Database): Promise<"Active" | "Pending Review"> {
  const [row] = await database
    .select({ value: platformSettings.settingValue })
    .from(platformSettings)
    .where(eq(platformSettings.settingKey, "marketplace"));
  const settings = (row?.value ?? {}) as Record<string, unknown>;
  return settings.autoPublishVerified === true ? "Active" : "Pending Review";
}

function newListingId() {
  const id = `lst_${randomUUID().replaceAll("-", "")}`;
  return { id, suffix: id.slice(4, 12), year: new Date().getUTCFullYear() };
}

/** Matches every word of the search against the product, region, grade, description, owner or reference. */
function searchCondition(search: string) {
  const words = search.split(/\s+/).filter(Boolean).slice(0, 6);
  return and(...words.map((word) => {
    const pattern = `%${word.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    return sql`(
      ${listings.product} ilike ${pattern} or ${listings.category} ilike ${pattern}
      or ${listings.region} ilike ${pattern} or ${listings.grade} ilike ${pattern}
      or ${listings.process} ilike ${pattern} or ${listings.description} ilike ${pattern}
      or ${listings.reference} ilike ${pattern}
      or ${traders.displayName} ilike ${pattern} or ${traders.businessName} ilike ${pattern}
      or exists (select 1 from catalog_products cp where cp.id = ${listings.productId}
                 and (cp.name ilike ${pattern} or cp.name_am ilike ${pattern}))
    )`;
  }));
}

export async function listLiveListings(
  database: Database,
  filters: ListingFilters,
  page: PageRequest,
) {
  const cursor = page.after;
  return database
    .select({
      ...listingSelection,
      _k0: sql<string>`${listings.createdAt}::text`,
      _k1: listings.id,
    })
    .from(listings)
    .innerJoin(traders, eq(traders.id, listings.ownerId))
    .where(
      and(
        filters.intent ? eq(listings.intent, filters.intent) : undefined,
        filters.category ? eq(listings.category, filters.category) : undefined,
        filters.search ? searchCondition(filters.search) : undefined,
        sql`${listings.status} in ('Active', 'Closing Soon')`,
        eq(traders.status, "Active"),
        or(
          and(eq(traders.verified, true), eq(traders.phoneVerified, true)),
          eq(listings.source, "legacy-ankuaru"),
        ),
        sql`case when ${listings.intent} = 'buy' then ${traders.role} in ('buyer', 'both') else ${traders.role} in ('seller', 'both') end`,
        cursor
          ? or(
              lt(listings.createdAt, new Date(cursor[0])),
              and(eq(listings.createdAt, new Date(cursor[0])), lt(listings.id, cursor[1])),
            )
          : undefined,
      ),
    )
    .orderBy(desc(listings.createdAt), desc(listings.id))
    .limit(page.limit + 1);
}

/** Counts one open of a listing's public detail page. */
export async function recordListingView(database: Database, listingId: string) {
  await database
    .update(listings)
    .set({ views: sql`${listings.views} + 1` })
    .where(eq(listings.id, listingId));
}

export async function findLiveListing(database: Database, listingId: string) {
  const [row] = await database
    .select(listingSelection)
    .from(listings)
    .innerJoin(traders, eq(traders.id, listings.ownerId))
    .where(
      and(
        eq(listings.id, listingId),
        sql`${listings.status} in ('Active', 'Closing Soon')`,
        eq(traders.status, "Active"),
        or(
          and(eq(traders.verified, true), eq(traders.phoneVerified, true)),
          eq(listings.source, "legacy-ankuaru"),
        ),
        sql`case when ${listings.intent} = 'buy' then ${traders.role} in ('buyer', 'both') else ${traders.role} in ('seller', 'both') end`,
      ),
    );
  if (!row) throw new ApiError(404, "listing_not_found", "Listing not found.");
  return row;
}

export async function listOwnerListings(database: Database, ownerId: string, page: PageRequest) {
  const cursor = page.after;
  return database
    .select({
      ...listingSelection,
      views: listings.views,
      inquiries_count: sql<number>`(select count(*)::int from inquiries where "inquiries"."listing_id" = "listings"."id")`,
      _k0: sql<string>`${listings.createdAt}::text`,
      _k1: listings.id,
    })
    .from(listings)
    .where(
      and(
        eq(listings.ownerId, ownerId),
        cursor
          ? or(
              lt(listings.createdAt, new Date(cursor[0])),
              and(eq(listings.createdAt, new Date(cursor[0])), lt(listings.id, cursor[1])),
            )
          : undefined,
      ),
    )
    .orderBy(desc(listings.createdAt), desc(listings.id))
    .limit(page.limit + 1);
}

/** The editable fields of a listing, validated; the same rules for create and edit. */
function parseListingFields(body: Record<string, unknown>) {
  const core = listingCoreSchema.safeParse(body);
  if (!core.success) {
    invalidListing("A buy or sell intent, category, and product are required.");
  }
  const { intent, category, product } = core.data;

  const priceResult = priceAmountSchema.safeParse(body.price_amount ?? null);
  if (!priceResult.success) {
    throw new ApiError(400, "invalid_price", "Price must be a non-negative number.");
  }
  const price = priceResult.data;
  const currencyResult =
    body.price_currency === undefined || body.price_currency === null
      ? { success: true as const, data: "USD" }
      : priceCurrencySchema.safeParse(body.price_currency);
  if (!currencyResult.success) {
    throw new ApiError(400, "invalid_currency", "Currency must be 1 to 8 characters.");
  }
  const availableFrom = optionalText(body.available_from, "available_from");
  if (availableFrom !== null && !calendarDateSchema.safeParse(availableFrom).success) {
    invalidListing("available_from must be a YYYY-MM-DD date.");
  }
  return {
    intent,
    category,
    product,
    quantity: optionalText(body.quantity, "quantity"),
    priceAmount: price === null || price === undefined ? null : String(price),
    priceCurrency: currencyResult.data,
    availableFrom,
    description: optionalText(body.description, "description"),
    imageUrl: optionalText(body.image_url, "image_url"),
    region: optionalText(body.region, "region", 100),
    grade: optionalText(body.grade, "grade", 100),
    process: optionalText(body.process, "process", 100),
    transactionType: optionalText(body.transaction_type, "transaction_type", 100),
  };
}

/** The owner's trading standing, or 401 when the account is gone. */
async function findOwner(database: Database, ownerId: string) {
  const [owner] = await database.select({ verified: traders.verified, phoneVerified: traders.phoneVerified, role: traders.role })
    .from(traders).where(eq(traders.id, ownerId));
  if (!owner) throw new ApiError(401, "unauthorized", "A valid session is required.");
  return { ...owner, ready: owner.verified && owner.phoneVerified };
}

/** The active catalog product a listing names, stored by key with its catalog id. */
async function catalogProduct(database: Database, category: string, product: string) {
  const match = await resolveProduct(database, category, product);
  if (!match?.active) {
    throw new ApiError(400, "invalid_product", "Choose a product from the catalog for this category.");
  }
  return { product: match.key, productId: match.id };
}

function assertRoleAllows(role: string, intent: string) {
  if ((intent === "sell" && role === "buyer") || (intent === "buy" && role === "seller")) {
    throw new ApiError(403, "trader_role_not_allowed", "Your account role does not allow this listing type.");
  }
}

export async function createListing(
  database: Database,
  ownerId: string,
  body: Record<string, unknown>,
) {
  const fields = parseListingFields(body);
  const owner = await findOwner(database, ownerId);
  assertRoleAllows(owner.role, fields.intent);
  const product = await catalogProduct(database, fields.category, fields.product);

  const { id, suffix, year } = newListingId();
  await database.insert(listings).values({
    id,
    ownerId,
    reference: `ANK-IOI-${year}-${suffix}`,
    ...fields,
    ...product,
    // Unverified traders save a draft; verified traders submit it for approval.
    status: owner.ready ? await submittedStatus(database) : "Draft",
  });
  // Only Active listings of verified owners reach the public feed.
  return findListing(database, id);
}

/** Statuses an owner can still edit; closed and expired listings are final. */
const EDITABLE_STATUSES = ["Draft", "Pending Review", "Rejected", "Active", "Closing Soon", "Flagged"];

/**
 * Replaces a listing's details. Any change to a submitted listing goes back to
 * staff review (or straight live with auto-publish), so the market only shows
 * what staff approved; drafts stay drafts. The buy/sell intent cannot change.
 */
export async function updateOwnerListing(
  database: Database,
  ownerId: string,
  listingId: string,
  body: Record<string, unknown>,
) {
  const [current] = await database.select({
    intent: listings.intent,
    status: listings.status,
    category: listings.category,
    product: listings.product,
  }).from(listings).where(and(eq(listings.id, listingId), eq(listings.ownerId, ownerId)));
  if (!current) throw new ApiError(404, "listing_not_found", "Listing not found.");
  if (!EDITABLE_STATUSES.includes(current.status)) {
    throw new ApiError(409, "listing_not_editable", "Closed listings cannot be edited.");
  }
  const fields = parseListingFields({ ...body, intent: current.intent });
  const owner = await findOwner(database, ownerId);
  assertRoleAllows(owner.role, fields.intent);
  // A retired product stays on the listing; a change must pick an active one.
  const product = fields.category === current.category && fields.product === current.product
    ? {}
    : await catalogProduct(database, fields.category, fields.product);
  const status = current.status === "Draft" || !owner.ready ? "Draft" : await submittedStatus(database);
  const [row] = await database.update(listings)
    .set({ ...fields, ...product, status, reviewNote: null })
    .where(and(eq(listings.id, listingId), eq(listings.ownerId, ownerId)))
    .returning(listingSelection);
  if (!row) throw new ApiError(404, "listing_not_found", "Listing not found.");
  return row;
}

/** Takes a listing off the market for good, e.g. once the deal is done. */
export async function closeOwnerListing(database: Database, ownerId: string, listingId: string) {
  const [row] = await database.update(listings).set({ status: "Closed" })
    .where(and(
      eq(listings.id, listingId),
      eq(listings.ownerId, ownerId),
      sql`${listings.status} not in ('Closed', 'Expired')`,
    )).returning(listingSelection);
  if (row) return row;
  const [exists] = await database.select({ id: listings.id }).from(listings)
    .where(and(eq(listings.id, listingId), eq(listings.ownerId, ownerId)));
  if (!exists) throw new ApiError(404, "listing_not_found", "Listing not found.");
  throw new ApiError(409, "listing_already_closed", "This listing is already closed.");
}

/**
 * Deletes a draft or rejected listing that never reached anyone. Listings that
 * were live, or that have inquiries, are closed instead so the history stays.
 */
export async function deleteOwnerListing(database: Database, ownerId: string, listingId: string) {
  const [current] = await database.select({ status: listings.status }).from(listings)
    .where(and(eq(listings.id, listingId), eq(listings.ownerId, ownerId)));
  if (!current) throw new ApiError(404, "listing_not_found", "Listing not found.");
  const [received] = await database.select({ count: sql<number>`count(*)::int` }).from(inquiries)
    .where(eq(inquiries.listingId, listingId));
  if ((current.status !== "Draft" && current.status !== "Rejected") || (received?.count ?? 0) > 0) {
    throw new ApiError(409, "listing_not_deletable", "Only drafts and rejected listings without inquiries can be deleted. Close it instead.");
  }
  await database.delete(listings).where(and(eq(listings.id, listingId), eq(listings.ownerId, ownerId)));
  return { id: listingId, deleted: true };
}

/**
 * Submits a draft, or a rejected listing after changes, for staff approval.
 * Needs a verified trader. A listing already awaiting review is left as is.
 */
export async function publishOwnerListing(database: Database, ownerId: string, listingId: string) {
  const owner = await findOwner(database, ownerId);
  if (!owner.ready) {
    throw new ApiError(403, "verification_required", "Verify your identity and phone before submitting listings.");
  }
  const [prepared] = await database.select({ intent: listings.intent, status: listings.status }).from(listings)
    .where(and(eq(listings.id, listingId), eq(listings.ownerId, ownerId)));
  if (!prepared) throw new ApiError(404, "listing_not_found", "Listing not found.");
  assertRoleAllows(owner.role, prepared.intent);
  if (prepared.status === "Pending Review") return findListing(database, listingId);
  if (prepared.status !== "Draft" && prepared.status !== "Rejected") {
    throw new ApiError(409, "listing_not_submittable", "Only drafts and rejected listings can be submitted.");
  }
  const [row] = await database.update(listings)
    .set({ status: await submittedStatus(database), reviewNote: null })
    .where(and(
      eq(listings.id, listingId),
      eq(listings.ownerId, ownerId),
      sql`${listings.status} in ('Draft', 'Rejected')`,
    )).returning(listingSelection);
  if (!row) throw new ApiError(404, "listing_not_found", "Listing not found.");
  return row;
}

/**
 * Imports a copied Telegram trade post as a Pending Review listing. Imports
 * are idempotent per message ID, including concurrent imports of one message.
 */
export async function importTelegramListing(
  database: Database,
  ownerId: string,
  body: Record<string, unknown>,
) {
  const input = telegramImportSchema.safeParse(body);
  if (!input.success) {
    throw new ApiError(
      400,
      "invalid_telegram_message",
      "A Telegram message ID (up to 128 bytes) and text are required.",
    );
  }
  const { message_id: messageId, text } = input.data;

  const imported = async () =>
    (
      await database
        .select(listingSelection)
        .from(listings)
        .where(and(eq(listings.source, "telegram"), eq(listings.sourceReference, messageId)))
    )[0];
  const existing = await imported();
  if (existing) return { listing: existing, duplicate: true };

  const parsed = parseTelegramListing(text);
  if (!parsed) {
    throw new ApiError(
      422,
      "telegram_message_not_a_listing",
      "This message does not look like a coffee trade post.",
    );
  }
  const { id, suffix, year } = newListingId();
  const [row] = await database
    .insert(listings)
    .values({
      id,
      ownerId,
      reference: `ANK-TG-${year}-${suffix}`,
      intent: parsed.intent,
      category: "coffee",
      product: "Export Coffee",
      quantity: parsed.quantity,
      description: parsed.description,
      region: parsed.region,
      grade: parsed.grade,
      process: parsed.process,
      transactionType: parsed.transaction_type,
      source: "telegram",
      sourceReference: messageId,
      status: "Pending Review",
    })
    .onConflictDoNothing({
      target: [listings.source, listings.sourceReference],
      where: isNotNull(listings.sourceReference),
    })
    .returning();
  if (row) return { listing: await findListing(database, id), duplicate: false };
  // A concurrent import of the same message committed first.
  return { listing: await imported(), duplicate: true };
}

async function findListing(database: Database, id: string) {
  const [row] = await database.select(listingSelection).from(listings).where(eq(listings.id, id));
  return row;
}
