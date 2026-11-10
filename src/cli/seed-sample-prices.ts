/**
 * Seeds SAMPLE reference prices (8 weekly points per product) and a sample
 * USD/ETB exchange rate, so the mobile price board has data in development:
 *   npm run prices:seed-sample
 *
 * These are illustrative numbers, not real market data. Every row is marked
 * created_by = 'seed:sample-prices' (exchange rates: the client account), and
 * re-running replaces the earlier sample prices. Remove them with:
 *   DELETE FROM market_prices WHERE created_by = 'seed:sample-prices';
 */
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { accounts, catalogProducts, exchangeRates, marketPrices } from "../infrastructure/database/schema.js";

const MARKER = "seed:sample-prices";
const clientEmail = process.env.SYSTEM_CLIENT_EMAIL ?? "client@ankuaru.local";

/** Oldest to newest weekly prices. */
const SAMPLES: { productId: string; market: string; currency: "ETB" | "USD"; weekly: number[] }[] = [
  { productId: "export-coffee", market: "ECX Addis", currency: "USD", weekly: [5.1, 5.15, 5.3, 5.25, 5.4, 5.55, 5.5, 5.8] },
  { productId: "roasted-coffee", market: "Addis Ababa", currency: "ETB", weekly: [1350, 1380, 1380, 1400, 1420, 1410, 1440, 1450] },
  { productId: "reject-coffee", market: "Jimma", currency: "ETB", weekly: [30000, 29500, 29000, 29200, 28800, 28500, 28300, 28000] },
  { productId: "oil-seeds-general", market: "Humera", currency: "ETB", weekly: [21000, 21400, 21800, 22300, 22100, 22600, 23000, 23500] },
  { productId: "pulses-legumes-general", market: "Hawassa", currency: "ETB", weekly: [9200, 9300, 9500, 9450, 9600, 9700, 9750, 9800] },
  { productId: "spices-herbs-general", market: "Bonga", currency: "ETB", weekly: [40000, 40500, 41000, 41500, 41200, 41800, 42200, 42000] },
  { productId: "grains-cereals-general", market: "Bahir Dar", currency: "ETB", weekly: [12800, 12900, 13100, 13000, 13200, 13300, 13400, 13500] },
  { productId: "fruit-crops-general", market: "Sidama", currency: "USD", weekly: [690, 700, 705, 700, 710, 715, 718, 720] },
  { productId: "vegetables-general", market: "Meki", currency: "ETB", weekly: [3600, 3550, 3500, 3400, 3350, 3300, 3250, 3200] },
  { productId: "root-crops-general", market: "Holeta", currency: "ETB", weekly: [2200, 2250, 2300, 2280, 2320, 2350, 2380, 2400] },
];

const SAMPLE_RATE = "155.75";
const day = 24 * 60 * 60 * 1000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

const pool = createPool(loadConfig().databaseUrl, 1);
const database = createDatabase(pool);

try {
  const applied = await migrate(pool);
  if (applied.length) console.log("Applied migrations: " + applied.join(", "));

  const [client] = await database.select({ id: accounts.id }).from(accounts).where(eq(accounts.email, clientEmail));
  if (!client) throw new Error(`No account for ${clientEmail}. Run npm run client:seed first.`);

  const known = new Set((await database.select({ id: catalogProducts.id }).from(catalogProducts)
    .where(inArray(catalogProducts.id, SAMPLES.map((s) => s.productId)))).map((r) => r.id));

  const count = await database.transaction(async (tx) => {
    await tx.delete(marketPrices).where(eq(marketPrices.createdBy, MARKER));
    let inserted = 0;
    for (const sample of SAMPLES) {
      if (!known.has(sample.productId)) {
        console.warn(`Skipped ${sample.productId}: not in the catalog.`);
        continue;
      }
      const rows = sample.weekly.map((price, index) => ({
        productId: sample.productId,
        price: String(price),
        currency: sample.currency,
        market: sample.market,
        priceDate: isoDay(new Date(Date.now() - (sample.weekly.length - 1 - index) * 7 * day)),
        createdBy: MARKER,
      }));
      await tx.insert(marketPrices).values(rows);
      inserted += rows.length;
    }

    const [rate] = await tx.select({ id: exchangeRates.id }).from(exchangeRates)
      .where(eq(exchangeRates.baseCurrency, "USD")).limit(1);
    if (!rate) {
      await tx.insert(exchangeRates).values({
        baseCurrency: "USD",
        quoteCurrency: "ETB",
        rate: SAMPLE_RATE,
        effectiveAt: new Date(),
        createdBy: client.id,
      });
      console.log(`Added sample USD/ETB rate ${SAMPLE_RATE}.`);
    }
    return inserted;
  });

  console.log(`Seeded ${count} sample reference prices (marked ${MARKER}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
