import { createHash } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/db.js";
import { legacyListingImports, legacyNewsImports, legacyUsers, listings, newsPosts, traders } from "../../infrastructure/database/schema.js";
import { transaction } from "../../infrastructure/database/transaction.js";
import type { LegacyData, LegacyNewsData, LegacyNewsItem, LegacyOffer, LegacyUser } from "./source.js";

export const NEWS_IMPORTER_ID = "legacy-news";

type OwnerMap = Map<string, LegacyUser | null>;
const INSERT_BATCH_SIZE = 250;

function batches<T>(items: T[], size = INSERT_BATCH_SIZE) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sourceKey(offer: LegacyOffer) {
  return `${offer.route}:${offer.id}`;
}

function localListingId(key: string) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `legacy_${hash}`;
}

function ownerMap(users: LegacyUser[]): OwnerMap {
  const owners = new Map<string, LegacyUser>();
  const ambiguous = new Set<string>();
  const duplicateChats = new Set<string>();
  for (const user of users) {
    if (!user.chat_id) continue;
    if (owners.has(user.chat_id)) duplicateChats.add(user.chat_id);
    else owners.set(user.chat_id, user);
  }
  for (const chatId of duplicateChats) ambiguous.add(chatId);
  const result: OwnerMap = new Map(owners);
  for (const chatId of ambiguous) result.set(chatId, null);
  return result;
}

function resolveOwner(offer: LegacyOffer, users: LegacyUser[], byChat: OwnerMap) {
  if (!offer.chat_id) throw new Error(`${offer.route}/${offer.id}: offer has no owner reference`);
  const owner = byChat.has(offer.chat_id)
    ? byChat.get(offer.chat_id)
    : users.find((user) => user.id === offer.chat_id);
  if (!owner) {
    throw new Error(`${offer.route}/${offer.id}: owner reference is missing or ambiguous`);
  }
  return owner;
}

function numericValue(value: number | string | null | undefined, field: string, key: string) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key}: ${field} is not a non-negative number`);
  }
  return String(parsed);
}

function listingValues(offer: LegacyOffer, owner: LegacyUser) {
  const key = sourceKey(offer);
  const id = localListingId(key);
  const quantity = offer.quantity == null || String(offer.quantity).trim() === ""
    ? null
    : `${String(offer.quantity).trim()}${offer.measurement ? ` ${offer.measurement}` : ""}`;
  const price = numericValue(offer.price, "price", key);
  const isLiveAtSource = offer.status && !offer.hidden_by_admin;
  return {
    id,
    ownerId: owner.id,
    reference: `LEG-${id.slice(-12).toUpperCase()}`,
    intent: offer.offer_type,
    category: offer.categoryId,
    product: offer.product_name,
    status: isLiveAtSource ? "Active" : "Closed",
    createdAt: new Date(offer.createdAt),
    quantity,
    priceAmount: price,
    priceCurrency: offer.price_currency ?? "USD",
    description: offer.description,
    imageUrl: offer.image_filelink,
    region: offer.region,
    grade: offer.grade,
    process: offer.process,
    transactionType: offer.transaction,
    source: "legacy-ankuaru",
    sourceReference: key,
  };
}

/** Imports source records once. Reruns only add previously unseen users and offers. */
export async function importLegacyData(database: Database, data: LegacyData) {
  if (!Number.isFinite(Date.parse(data.since))) throw new Error("Invalid migration cutoff");
  const byChat = ownerMap(data.users);
  const resolvedOffers = data.offers.map((offer) => {
    const owner = resolveOwner(offer, data.users, byChat);
    return { offer, owner, values: listingValues(offer, owner) };
  });
  const phoneCounts = new Map<string, number>();
  for (const user of data.users) {
    if (user.phone) phoneCounts.set(user.phone, (phoneCounts.get(user.phone) ?? 0) + 1);
  }
  const candidatePhones = [...phoneCounts.keys()];

  return transaction(database, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('legacy-ankuaru-import'))`);
    const alreadyUsedPhones = candidatePhones.length
      ? new Set((await tx.select({ phone: traders.phone }).from(traders)
        .where(inArray(traders.phone, candidatePhones))).map(({ phone }) => phone))
      : new Set<string | null>();
    const existingUsers = await tx.select({
      sourceId: legacyUsers.sourceId,
      traderId: legacyUsers.traderId,
    }).from(legacyUsers);
    const legacyUserIds = new Map(existingUsers.map(({ sourceId, traderId }) => [sourceId, traderId]));

    const newUsers: LegacyUser[] = [];
    for (const user of data.users) {
      const currentTraderId = legacyUserIds.get(user.id);
      if (currentTraderId && currentTraderId !== user.id) {
        throw new Error(`Legacy user ${user.id} is already linked to a different profile`);
      }
      if (!currentTraderId) newUsers.push(user);
    }

    const traderRows = newUsers.map((user) => ({
      id: user.id,
      displayName: user.name ?? user.business_name ?? `Legacy trader ${user.id}`,
      businessName: user.business_name,
      city: user.city,
      createdAt: new Date(user.createdAt),
      phoneVerified: false,
      verificationTier: "registered" as const,
      verified: false,
      status: user.is_active ? "Active" as const : "Suspended" as const,
    }));
    const legacyUserRows = newUsers.map((user) => {
      const phoneIsUnique = user.phone !== null && phoneCounts.get(user.phone) === 1;
      const claimPhone = user.is_active && phoneIsUnique && !alreadyUsedPhones.has(user.phone)
        ? user.phone
        : null;
      return {
        sourceId: user.id,
        traderId: user.id,
        chatId: user.chat_id,
        claimPhone,
        claimBlocked: claimPhone === null,
        cutoverAt: new Date(data.since),
      };
    });
    for (const rows of batches(traderRows)) {
      await tx.insert(traders).values(rows);
    }
    for (const rows of batches(legacyUserRows)) {
      await tx.insert(legacyUsers).values(rows);
    }

    const offerKeys = resolvedOffers.map(({ offer }) => sourceKey(offer));
    const importedKeys = offerKeys.length
      ? new Set((await tx.select({ sourceKey: legacyListingImports.sourceKey })
        .from(legacyListingImports)
        .where(inArray(legacyListingImports.sourceKey, offerKeys))).map(({ sourceKey }) => sourceKey))
      : new Set<string>();
    const newOffers = resolvedOffers.filter(({ offer }) => !importedKeys.has(sourceKey(offer)));
    const listingsInserted = newOffers.length;

    for (const rows of batches(newOffers.map(({ values }) => values))) {
      await tx.insert(listings).values(rows).onConflictDoNothing();
    }

    const newOfferKeys = newOffers.map(({ offer }) => sourceKey(offer));
    const listingRows = newOfferKeys.length
      ? await tx.select({
          id: listings.id,
          sourceReference: listings.sourceReference,
        }).from(listings)
          .where(and(
            eq(listings.source, "legacy-ankuaru"),
            inArray(listings.sourceReference, newOfferKeys),
          ))
      : [];
    const listingsByKey = new Map(
      listingRows.map(({ id, sourceReference }) => [sourceReference!, id]),
    );
    const importRows = newOffers.map(({ offer, owner, values }) => {
      const key = sourceKey(offer);
      const listingId = listingsByKey.get(key);
      if (!listingId || listingId !== values.id) {
        throw new Error(`${key}: could not establish the imported listing record`);
      }
      return {
        sourceKey: key,
        listingId,
        sourceUserId: owner.id,
        snapshot: offer,
      };
    });
    for (const rows of batches(importRows)) {
      await tx.insert(legacyListingImports).values(rows);
    }

    return {
      usersInserted: newUsers.length,
      listingsInserted,
      usersSeen: data.users.length,
      offersSeen: data.offers.length,
    };
  });
}

function newsValues(item: LegacyNewsItem) {
  const publishedAt = new Date(item.createdAt);
  return {
    title: item.title,
    titleAm: item.titleAm,
    summary: item.summary,
    body: item.body,
    category: item.category,
    kind: item.kind,
    source: "ANKUARU",
    imageUrl: item.imageUrl,
    featured: false,
    status: "Published" as const,
    createdBy: NEWS_IMPORTER_ID,
    publishedAt,
    createdAt: publishedAt,
    updatedAt: item.updatedAt ? new Date(item.updatedAt) : publishedAt,
  };
}

/** Imports source news once. Reruns only add previously unseen posts. */
export async function importLegacyNews(database: Database, data: LegacyNewsData) {
  if (!Number.isFinite(Date.parse(data.since))) throw new Error("Invalid migration cutoff");
  return transaction(database, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('legacy-ankuaru-news-import'))`);
    await tx.insert(traders).values({
      id: NEWS_IMPORTER_ID,
      displayName: "Ankuaru News",
      status: "Active",
      verificationTier: "registered",
      verified: false,
      phoneVerified: false,
      role: "both",
    }).onConflictDoNothing();

    const sourceIds = data.news.map((item) => item.id);
    const imported = sourceIds.length
      ? await tx.select({
          sourceId: legacyNewsImports.sourceId,
          newsPostId: legacyNewsImports.newsPostId,
        }).from(legacyNewsImports).where(inArray(legacyNewsImports.sourceId, sourceIds))
      : [];
    const importedIds = new Map(imported.map((row) => [row.sourceId, row.newsPostId]));
    const newItems = data.news.filter((item) => !importedIds.has(item.id));
    const inserted: { item: LegacyNewsItem; id: string }[] = [];
    for (const item of newItems) {
      const [row] = await tx.insert(newsPosts).values(newsValues(item)).returning({ id: newsPosts.id });
      inserted.push({ item, id: row.id });
    }
    if (inserted.length) {
      await tx.insert(legacyNewsImports).values(inserted.map(({ item, id }) => ({
        sourceId: item.id,
        newsPostId: id,
        snapshot: item,
      })));
    }

    let newsUpdated = 0;
    const bySource = new Map(data.news.map((item) => [item.id, item]));
    for (const row of imported) {
      if (!row.newsPostId) continue;
      const item = bySource.get(row.sourceId);
      if (!item) continue;
      const [updated] = await tx.update(newsPosts).set({ kind: item.kind, updatedAt: new Date() })
        .where(and(eq(newsPosts.id, row.newsPostId), ne(newsPosts.kind, item.kind)))
        .returning({ id: newsPosts.id });
      if (updated) newsUpdated++;
    }
    return {
      newsInserted: inserted.length,
      newsUpdated,
      newsSeen: data.news.length,
    };
  });
}
