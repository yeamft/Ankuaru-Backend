/**
 * Seeds sample marketplace listings (products) and news posts owned by the
 * client account (SYSTEM_CLIENT_EMAIL, default client@ankuaru.local):
 *   npm run client:seed-content
 *
 * Run client:seed first. Safe to re-run: listings are keyed by
 * (source='seed', source_reference) and news posts by title, so existing
 * records are skipped.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { accounts, catalogProducts, listings, newsPosts } from "../infrastructure/database/schema.js";
import { emailSchema } from "../modules/auth/schemas.js";

const emailResult = emailSchema.safeParse(process.env.SYSTEM_CLIENT_EMAIL ?? "client@ankuaru.local");
if (!emailResult.success) {
  console.error("SYSTEM_CLIENT_EMAIL must be a valid email address.");
  process.exit(2);
}
const clientEmail = emailResult.data;

type ListingSeed = {
  key: string;
  intent: "buy" | "sell";
  category: string;
  productId: string;
  quantity: string;
  price: string;
  currency: "USD" | "ETB";
  region?: string;
  grade?: string;
  process?: string;
  transactionType?: string;
  description: string;
  daysAgo: number;
};

const LISTINGS: ListingSeed[] = [
  { key: "yirgacheffe-g1-washed", intent: "sell", category: "coffee", productId: "export-coffee", quantity: "120 Quintal", price: "5.80", currency: "USD", region: "Yirgacheffe", grade: "Grade 1", process: "Washed", transactionType: "FOB", description: "Fresh crop washed Yirgacheffe, floral and citrus notes. Cupping score 87+.", daysAgo: 1 },
  { key: "guji-g1-natural", intent: "sell", category: "coffee", productId: "export-coffee", quantity: "80 Quintal", price: "6.10", currency: "USD", region: "Guji", grade: "Grade 1", process: "Natural", transactionType: "FOB", description: "Sun-dried Guji natural with berry and chocolate profile, ready for export.", daysAgo: 2 },
  { key: "sidama-g2-washed", intent: "buy", category: "coffee", productId: "export-coffee", quantity: "200 Quintal", price: "4.90", currency: "USD", region: "Sidama", grade: "Grade 2", process: "Washed", transactionType: "FOB", description: "Looking for consistent Sidama Grade 2 washed lots for a long-term contract.", daysAgo: 3 },
  { key: "roasted-medium-blend", intent: "sell", category: "coffee", productId: "roasted-coffee", quantity: "500 kg", price: "1450", currency: "ETB", region: "Jimma", process: "Natural", transactionType: "Local", description: "Medium roast house blend, packed in 1 kg valve bags. Delivery in Addis Ababa.", daysAgo: 4 },
  { key: "reject-coffee-local", intent: "sell", category: "coffee", productId: "reject-coffee", quantity: "60 Quintal", price: "28000", currency: "ETB", region: "Limu", transactionType: "Local", description: "Under-grade coffee suitable for local roasting market.", daysAgo: 6 },
  { key: "sesame-humera", intent: "sell", category: "oil-seeds", productId: "oil-seeds-general", quantity: "300 Quintal", price: "1650", currency: "USD", region: "Humera", transactionType: "FOB", description: "Whitish Humera sesame, 99/1 purity, machine cleaned.", daysAgo: 2 },
  { key: "red-kidney-beans", intent: "buy", category: "pulses-legumes", productId: "pulses-legumes-general", quantity: "150 Quintal", price: "9800", currency: "ETB", region: "Hawassa", transactionType: "Local", description: "Buying speckled red kidney beans, moisture below 13%.", daysAgo: 5 },
  { key: "korarima-spice", intent: "sell", category: "spices-herbs", productId: "spices-herbs-general", quantity: "20 Quintal", price: "42000", currency: "ETB", region: "Kaffa", transactionType: "Local", description: "Dried korarima (Ethiopian cardamom) from Kaffa forest, sorted and bagged.", daysAgo: 7 },
  { key: "white-teff-magna", intent: "sell", category: "grains-cereals", productId: "grains-cereals-general", quantity: "100 Quintal", price: "13500", currency: "ETB", region: "Gojjam", grade: "Magna", transactionType: "Local", description: "Premium magna white teff, cleaned and ready for pickup.", daysAgo: 3 },
  { key: "avocado-hass", intent: "sell", category: "fruit-crops", productId: "fruit-crops-general", quantity: "10 MT", price: "720", currency: "USD", region: "Sidama", transactionType: "FOB", description: "Export-grade Hass avocado, size 16–22, available weekly.", daysAgo: 8 },
  { key: "onion-red", intent: "buy", category: "vegetables", productId: "vegetables-general", quantity: "80 Quintal", price: "3200", currency: "ETB", region: "Meki", transactionType: "Local", description: "Need red onion for wholesale distribution in Addis Ababa.", daysAgo: 1 },
  { key: "potato-gudene", intent: "sell", category: "root-crops", productId: "root-crops-general", quantity: "120 Quintal", price: "2400", currency: "ETB", region: "Holeta", transactionType: "Local", description: "Gudene variety potatoes, fresh harvest, graded by size.", daysAgo: 4 },
];

type NewsSeed = {
  title: string;
  titleAm: string;
  summary: string;
  body: string;
  category: "Market" | "Origins" | "Platform" | "Export" | "Policy";
  featured: boolean;
  status: "Draft" | "Published";
  daysAgo: number;
};

const NEWS: NewsSeed[] = [
  { title: "Coffee export prices firm as new harvest arrives", titleAm: "አዲሱ ምርት ሲደርስ የቡና ኤክስፖርት ዋጋ ጠንክሯል", summary: "Washed Grade 1 lots from Yirgacheffe and Guji are trading higher as the new crop reaches warehouses.", body: "Exporters report strong demand for specialty washed lots this week. Buyers from Europe and East Asia are booking early contracts, and FOB offers for Grade 1 washed coffee have moved up compared with last month. Traders expect volumes to rise through December as processing stations finish drying.", category: "Market", featured: true, status: "Published", daysAgo: 0 },
  { title: "Sesame demand rises ahead of the Humera harvest", titleAm: "ከሁመራ ምርት በፊት የሰሊጥ ፍላጎት ጨመረ", summary: "International buyers are lining up contracts for whitish Humera sesame as harvest begins.", body: "The Humera sesame harvest is under way, and early quality reports are positive. Buyers are asking for 99/1 purity with machine cleaning, and traders with ready stock are receiving multiple inquiries. Logistics through Djibouti remain the main constraint on delivery schedules.", category: "Export", featured: false, status: "Published", daysAgo: 1 },
  { title: "Guji natural coffees win attention at cupping event", titleAm: "የጉጂ ተፈጥሯዊ ቡናዎች በቅምሻ ዝግጅት ትኩረት ሳቡ", summary: "Several Guji naturals scored above 88 points at this month's regional cupping session.", body: "Producers from Guji showcased sun-dried naturals with berry and chocolate notes. Judges highlighted improved sorting and drying practices. Several lots are now being offered on the marketplace to verified buyers.", category: "Origins", featured: false, status: "Published", daysAgo: 2 },
  { title: "Marketplace adds verified-trader badges to listings", titleAm: "ገበያው ለማስታወቂያዎች የተረጋገጠ ነጋዴ ምልክት አከለ", summary: "Buyers can now see at a glance which sellers have completed business verification.", body: "Listings from traders who completed individual or business verification now show a badge in the feed and on the detail page. Verification helps buyers trade with confidence and gives verified sellers better visibility.", category: "Platform", featured: false, status: "Published", daysAgo: 3 },
  { title: "New guidelines published for grain quality grading", titleAm: "ለእህል ጥራት ደረጃ አወጣጥ አዲስ መመሪያ ወጣ", summary: "Updated grading rules for teff and wheat take effect next quarter.", body: "The updated guidelines clarify moisture limits, foreign matter tolerances and labelling requirements for teff and wheat traded in local markets. Traders are encouraged to review the rules and update their listing descriptions accordingly.", category: "Policy", featured: false, status: "Published", daysAgo: 5 },
  { title: "Avocado exports expand to new Gulf markets", titleAm: "የአቮካዶ ኤክስፖርት ወደ አዲስ የባሕረ ሰላጤው ገበያዎች ተስፋፋ", summary: "Ethiopian Hass avocado shipments are reaching more buyers in the Gulf region.", body: "Growers in Sidama and Oromia are scaling up Hass avocado production, with weekly shipments now reaching several Gulf markets. Exporters say consistent sizing and cold-chain handling are key to keeping these contracts.", category: "Export", featured: false, status: "Published", daysAgo: 6 },
  { title: "Draft: Pulse market outlook for the coming season", titleAm: "ረቂቅ፡ ለመጪው ወቅት የጥራጥሬ ገበያ እይታ", summary: "An early look at supply and demand for beans, chickpeas and lentils.", body: "This draft outlook summarises expected planting areas, carry-over stock and export demand for major pulses. It will be updated once regional harvest estimates are confirmed.", category: "Market", featured: false, status: "Draft", daysAgo: 0 },
  { title: "Export Coffee Minimum Price Data From Nov 3 to 9/2026", titleAm: "ሳምንታዊ ለውጪ ገበያ የሚቀርብ የቡና አነሰተኛ የዋጋ ማንፃፀሪያ ከጥቅምት 24 እስከ 30/2019", summary: "Weekly minimum reference prices for coffee supplied to the export market, covering Nov 3 to 9, 2026 (Tikimt 24 to 30, 2019 E.C.).", body: "This weekly bulletin sets out the minimum reference prices for coffee supplied to the export market for the period Nov 3 to 9, 2026 (Tikimt 24 to 30, 2019 E.C.). Exporters and suppliers should use these figures as the floor when negotiating and registering export contracts during the week.", category: "Market", featured: true, status: "Published", daysAgo: 0 },
  { title: "Domestic Coffee Price Range", titleAm: "የሀገር ውስጥ የቡና የዋጋ ክልል", summary: "Weekly lower and upper reference purchase prices for domestic direct (vertically integrated) coffee trade, covering Nov 3 to 9, 2026 (Tikimt 24 to 30, 2019 E.C.).", body: "This weekly bulletin sets out the lower and upper reference purchase prices for coffee traded through domestic direct, vertically integrated channels for the period Nov 3 to 9, 2026 (Tikimt 24 to 30, 2019 E.C.). Producers and buyers should keep purchase prices within this range during the week.", category: "Market", featured: false, status: "Published", daysAgo: 0 },
];

const day = 24 * 60 * 60 * 1000;
const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log("Applied migrations: " + applied.join(", "));

  const [client] = await database.select({ id: accounts.id, accountRole: accounts.accountRole })
    .from(accounts).where(eq(accounts.email, clientEmail));
  if (!client) throw new Error(`No account for ${clientEmail}. Run npm run client:seed first.`);
  if (client.accountRole !== "user") throw new Error(`${clientEmail} is not a client account.`);

  const products = await database.select({ id: catalogProducts.id, key: catalogProducts.key, categoryId: catalogProducts.categoryId })
    .from(catalogProducts).where(inArray(catalogProducts.id, [...new Set(LISTINGS.map((l) => l.productId))]));
  const productById = new Map(products.map((p) => [p.id, p]));

  const result = await database.transaction(async (tx) => {
    let listingCount = 0;
    let newsCount = 0;
    let newsUpdated = 0;
    const year = new Date().getUTCFullYear();

    for (const seed of LISTINGS) {
      const product = productById.get(seed.productId);
      if (!product || product.categoryId !== seed.category) {
        console.warn(`Skipped listing ${seed.key}: catalog product ${seed.productId} not found.`);
        continue;
      }
      const sourceReference = `client-seed:${seed.key}`;
      const [existing] = await tx.select({ id: listings.id }).from(listings)
        .where(and(eq(listings.source, "seed"), eq(listings.sourceReference, sourceReference)));
      if (existing) continue;

      const id = `lst_${randomUUID().replaceAll("-", "")}`;
      const createdAt = new Date(Date.now() - seed.daysAgo * day);
      await tx.insert(listings).values({
        id,
        ownerId: client.id,
        reference: `ANK-IOI-${year}-${id.slice(4, 12)}`,
        intent: seed.intent,
        category: seed.category,
        product: product.key,
        productId: product.id,
        status: "Active",
        createdAt,
        quantity: seed.quantity,
        priceAmount: seed.price,
        priceCurrency: seed.currency,
        availableFrom: createdAt.toISOString().slice(0, 10),
        description: seed.description,
        region: seed.region ?? null,
        grade: seed.grade ?? null,
        process: seed.process ?? null,
        transactionType: seed.transactionType ?? null,
        source: "seed",
        sourceReference,
      });
      listingCount++;
    }

    const existing = new Map((await tx.select({ title: newsPosts.title, titleAm: newsPosts.titleAm }).from(newsPosts)
      .where(inArray(newsPosts.title, NEWS.map((n) => n.title)))).map((r) => [r.title, r.titleAm]));
    for (const seed of NEWS) {
      if (existing.has(seed.title)) {
        // Backfill the Amharic headline on posts seeded before it existed.
        if (!existing.get(seed.title)) {
          await tx.update(newsPosts).set({ titleAm: seed.titleAm, updatedAt: new Date() })
            .where(and(eq(newsPosts.title, seed.title), isNull(newsPosts.titleAm)));
          newsUpdated++;
        }
        continue;
      }
      const when = new Date(Date.now() - seed.daysAgo * day);
      await tx.insert(newsPosts).values({
        title: seed.title,
        titleAm: seed.titleAm,
        summary: seed.summary,
        body: seed.body,
        category: seed.category,
        featured: seed.featured,
        status: seed.status,
        createdBy: client.id,
        publishedAt: seed.status === "Published" ? when : null,
        createdAt: when,
        updatedAt: when,
      });
      newsCount++;
    }
    return { listingCount, newsCount, newsUpdated };
  });

  console.log(`Seeded for ${clientEmail}: ${result.listingCount} listings, ${result.newsCount} news posts.`);
  if (result.newsUpdated) console.log(`Added Amharic headlines to ${result.newsUpdated} existing news posts.`);
  if (!result.listingCount && !result.newsCount && !result.newsUpdated) console.log("Everything was already seeded; no changes made.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
