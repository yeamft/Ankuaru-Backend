/**
 * Seeds SAMPLE trader-to-trader interactions, so the admin "Trader interactions"
 * page has data to look at in development:
 *   npm run interactions:seed-sample
 *
 * Creates 6 sample traders (phones +25190000000x), 6 sample listings and 12
 * conversations between them over the last 3 weeks, each with its "contacted"
 * event and later status changes. The listings are Closed, so they stay off
 * the public marketplace. Everything uses the `smp_` id prefix, and re-running
 * replaces the earlier sample. Remove it all with:
 *   npm run interactions:seed-sample -- --remove
 */
import "dotenv/config";
import { inArray, like } from "drizzle-orm";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { accounts, inquiries, inquiryEvents, listings, traders } from "../infrastructure/database/schema.js";

const TRADERS = [
  { id: "smp_trader_1", name: "Abebe Kebede", business: "Sidama Green Coffee", phone: "+251900000001", city: "Hawassa", role: "seller" },
  { id: "smp_trader_2", name: "Hirut Tadesse", business: "Addis Roasters PLC", phone: "+251900000002", city: "Addis Ababa", role: "buyer" },
  { id: "smp_trader_3", name: "Mulugeta Alemu", business: null, phone: "+251900000003", city: "Jimma", role: "both" },
  { id: "smp_trader_4", name: "Selam Girma", business: "Humera Oilseed Union", phone: "+251900000004", city: "Humera", role: "seller" },
  { id: "smp_trader_5", name: "Dawit Bekele", business: "Horn Export Trading", phone: "+251900000005", city: "Dire Dawa", role: "buyer" },
  { id: "smp_trader_6", name: "Tigist Haile", business: null, phone: "+251900000006", city: "Bahir Dar", role: "both" },
] as const;

const LISTINGS = [
  { id: "smp_listing_1", owner: "smp_trader_1", reference: "SMP-1001", intent: "sell", category: "Coffee", product: "Sidama Grade 2 washed coffee", quantity: "120 bags", price: "5.40", currency: "USD" },
  { id: "smp_listing_2", owner: "smp_trader_4", reference: "SMP-1002", intent: "sell", category: "Oil seeds", product: "Humera white sesame", quantity: "40 tonnes", price: "23000", currency: "ETB" },
  { id: "smp_listing_3", owner: "smp_trader_2", reference: "SMP-1003", intent: "buy", category: "Coffee", product: "Roasting coffee, Grade 3–4", quantity: "60 bags", price: "1400", currency: "ETB" },
  { id: "smp_listing_4", owner: "smp_trader_3", reference: "SMP-1004", intent: "sell", category: "Spices", product: "Korarima (Ethiopian cardamom)", quantity: "2 tonnes", price: "42000", currency: "ETB" },
  { id: "smp_listing_5", owner: "smp_trader_5", reference: "SMP-1005", intent: "buy", category: "Pulses", product: "Red haricot beans", quantity: "100 tonnes", price: "9700", currency: "ETB" },
  { id: "smp_listing_6", owner: "smp_trader_6", reference: "SMP-1006", intent: "sell", category: "Grains", product: "Teff (magna)", quantity: "15 tonnes", price: "13400", currency: "ETB" },
] as const;

type Status = "New" | "Responded" | "Resolved" | "Closed";

/**
 * Who wrote, about which listing, how many days ago, and the status changes
 * after (by "contacter" or "owner", hours after the contact).
 */
const CONVERSATIONS: {
  from: string;
  listing: string;
  daysAgo: number;
  steps: { by: "contacter" | "owner"; to: Status; hours: number }[];
}[] = [
  { from: "smp_trader_2", listing: "smp_listing_1", daysAgo: 20, steps: [{ by: "owner", to: "Responded", hours: 3 }, { by: "contacter", to: "Resolved", hours: 50 }] },
  { from: "smp_trader_5", listing: "smp_listing_1", daysAgo: 18, steps: [{ by: "owner", to: "Responded", hours: 6 }, { by: "owner", to: "Closed", hours: 30 }] },
  { from: "smp_trader_5", listing: "smp_listing_2", daysAgo: 15, steps: [{ by: "owner", to: "Responded", hours: 1 }] },
  { from: "smp_trader_1", listing: "smp_listing_3", daysAgo: 14, steps: [{ by: "owner", to: "Responded", hours: 4 }, { by: "owner", to: "Resolved", hours: 26 }] },
  { from: "smp_trader_3", listing: "smp_listing_3", daysAgo: 12, steps: [{ by: "owner", to: "Responded", hours: 8 }] },
  { from: "smp_trader_6", listing: "smp_listing_4", daysAgo: 10, steps: [] },
  { from: "smp_trader_2", listing: "smp_listing_4", daysAgo: 9, steps: [{ by: "owner", to: "Responded", hours: 2 }, { by: "contacter", to: "Closed", hours: 20 }] },
  { from: "smp_trader_4", listing: "smp_listing_5", daysAgo: 7, steps: [{ by: "owner", to: "Responded", hours: 5 }, { by: "owner", to: "Resolved", hours: 40 }] },
  { from: "smp_trader_6", listing: "smp_listing_5", daysAgo: 5, steps: [{ by: "owner", to: "Responded", hours: 12 }] },
  { from: "smp_trader_5", listing: "smp_listing_6", daysAgo: 3, steps: [{ by: "owner", to: "Responded", hours: 2 }] },
  { from: "smp_trader_3", listing: "smp_listing_6", daysAgo: 1, steps: [] },
  { from: "smp_trader_2", listing: "smp_listing_2", daysAgo: 0, steps: [] },
];

const MESSAGES = [
  "Hello, is this still available? What is your best price for the full quantity?",
  "We are interested. Can you share a sample and delivery terms?",
  "Can you deliver to Addis Ababa within two weeks?",
];

const hour = 60 * 60 * 1000;
const remove = process.argv.includes("--remove");

const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log("Applied migrations: " + applied.join(", "));

  await database.transaction(async (tx) => {
    // Inquiry events go with their inquiries (on delete cascade).
    await tx.delete(inquiries).where(like(inquiries.listingId, "smp_listing_%"));
    await tx.delete(listings).where(like(listings.id, "smp_listing_%"));
    await tx.delete(traders).where(inArray(traders.id, TRADERS.map((t) => t.id)));
    if (remove) return;

    await tx.insert(traders).values(TRADERS.map((t) => ({
      id: t.id,
      displayName: t.name,
      businessName: t.business,
      phone: t.phone,
      city: t.city,
      phoneVerified: true,
      verified: true,
      role: t.role,
      status: "Active",
    })));
    await tx.insert(accounts).values(TRADERS.map((t) => ({ id: t.id, email: null, passwordHash: null })));
    await tx.insert(listings).values(LISTINGS.map((l, index) => ({
      id: l.id,
      ownerId: l.owner,
      reference: l.reference,
      intent: l.intent,
      category: l.category,
      product: l.product,
      quantity: l.quantity,
      priceAmount: l.price,
      priceCurrency: l.currency,
      source: "sample",
      // Off the public marketplace: sample data is for the admin console only.
      status: "Closed",
      createdAt: new Date(Date.now() - (25 - index) * 24 * hour),
    })));

    for (const [index, conversation] of CONVERSATIONS.entries()) {
      const listing = LISTINGS.find((l) => l.id === conversation.listing)!;
      const contacter = conversation.from;
      const owner = listing.owner;
      // An inquiry's buyer and seller follow the listing: on a buy request the owner is the buyer.
      const buyerId = listing.intent === "buy" ? owner : contacter;
      const sellerId = listing.intent === "buy" ? contacter : owner;
      const contactedAt = new Date(Date.now() - conversation.daysAgo * 24 * hour - (index % 5) * hour);
      const finalStatus = conversation.steps.at(-1)?.to ?? "New";

      const [inquiry] = await tx.insert(inquiries).values({
        listingId: listing.id,
        buyerId,
        sellerId,
        message: MESSAGES[index % MESSAGES.length],
        status: finalStatus,
        createdAt: contactedAt,
      }).returning({ id: inquiries.id });

      let previous: Status = "New";
      await tx.insert(inquiryEvents).values([
        { inquiryId: inquiry.id, actorId: contacter, kind: "contacted", toStatus: "New", createdAt: contactedAt },
        ...conversation.steps.map((step) => {
          const event = {
            inquiryId: inquiry.id,
            actorId: step.by === "owner" ? owner : contacter,
            kind: "status_changed",
            fromStatus: previous,
            toStatus: step.to,
            createdAt: new Date(contactedAt.getTime() + step.hours * hour),
          };
          previous = step.to;
          return event;
        }),
      ]);
    }
  });

  console.log(
    remove
      ? "Removed the sample traders, listings and interactions."
      : `Seeded ${TRADERS.length} sample traders, ${LISTINGS.length} listings and ${CONVERSATIONS.length} conversations.`,
  );
} finally {
  await pool.end();
}
