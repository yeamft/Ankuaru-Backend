import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { transaction } from "../../../infrastructure/database/index.js";
import { catalogProducts, exchangeRates, marketPrices } from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import { audit } from "../../admin/services/audit.service.js";

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const priceInput = z.object({
  product_id: z.string().trim().min(1),
  price: z.coerce.number().positive().max(1e12),
  currency: z.enum(["ETB", "USD"]).default("ETB"),
  market: z.string().trim().min(2).max(80),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const toResponse = (row: typeof marketPrices.$inferSelect) => ({
  id: row.id,
  product_id: row.productId,
  price: Number(row.price),
  currency: row.currency,
  market: row.market,
  date: row.priceDate,
  created_at: row.createdAt.toISOString(),
});

/** Reference prices, newest first; analytics and the value calculator read them. */
export async function listPrices(database: Database) {
  const rows = await database
    .select()
    .from(marketPrices)
    .orderBy(desc(marketPrices.priceDate), desc(marketPrices.createdAt))
    .limit(5000);
  return rows.map(toResponse);
}

/** Records one product's price on one market and day. */
export async function createPrice(database: Database, adminId: string, body: Record<string, unknown>) {
  const parsed = priceInput.safeParse(body);
  if (!parsed.success)
    throw new ApiError(400, "invalid_price", "Give a product, a price above 0, a market and a date.");
  const input = parsed.data;
  const today = new Date().toISOString().slice(0, 10);
  if (input.date > today) throw new ApiError(400, "invalid_price", "The date cannot be in the future.");
  const [product] = await database
    .select({ id: catalogProducts.id })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, input.product_id));
  if (!product) throw new ApiError(404, "product_not_found", "Product not found.");

  return transaction(database, async (tx) => {
    const [created] = await tx
      .insert(marketPrices)
      .values({
        productId: product.id,
        price: String(input.price),
        currency: input.currency,
        market: input.market,
        priceDate: input.date,
        createdBy: adminId,
      })
      .returning();
    await audit(tx, adminId, "price.recorded", "market_price", created!.id);
    return toResponse(created!);
  });
}

/** Removes a mistaken price entry. */
export async function deletePrice(database: Database, adminId: string, priceId: string) {
  if (!isUuid(priceId)) throw new ApiError(404, "price_not_found", "Price not found.");
  const [row] = await database
    .select({ id: marketPrices.id })
    .from(marketPrices)
    .where(eq(marketPrices.id, priceId));
  if (!row) throw new ApiError(404, "price_not_found", "Price not found.");
  await transaction(database, async (tx) => {
    await tx.delete(marketPrices).where(eq(marketPrices.id, priceId));
    await audit(tx, adminId, "price.deleted", "market_price", priceId);
  });
  return { id: priceId, deleted: true };
}

type LatestPriceRow = {
  product_id: string;
  product_name: string;
  product_name_am: string | null;
  category_id: string;
  unit: string;
  market: string;
  currency: string;
  history: { date: string; price: number }[];
};

/**
 * The public price board: for each product, market and currency, the newest
 * reference price, the one before it and up to 12 recent points for a trend
 * line; plus the newest USD/ETB exchange rate.
 */
export async function latestPrices(database: Database) {
  const rows = (await database.execute(sql`
    WITH ranked AS (
      SELECT mp.product_id, mp.market, mp.currency, mp.price_date, mp.price::double precision AS price,
        row_number() OVER (PARTITION BY mp.product_id, mp.market, mp.currency
                           ORDER BY mp.price_date DESC, mp.created_at DESC) AS rn
      FROM market_prices mp
      WHERE mp.price_date >= current_date - 180
    )
    SELECT r.product_id, cp.name AS product_name, cp.name_am AS product_name_am,
      cp.category_id, cp.unit, r.market, r.currency,
      json_agg(json_build_object('date', to_char(r.price_date, 'YYYY-MM-DD'), 'price', r.price)
               ORDER BY r.price_date) AS history
    FROM ranked r
    JOIN catalog_products cp ON cp.id = r.product_id AND cp.active
    JOIN catalog_categories cc ON cc.id = cp.category_id AND cc.active
    WHERE r.rn <= 12
    GROUP BY r.product_id, cp.name, cp.name_am, cp.category_id, cp.unit, cp.sort_order, cc.sort_order, r.market, r.currency
    ORDER BY cc.sort_order, cp.sort_order, cp.name, r.market`)).rows as LatestPriceRow[];

  const prices = rows.map((row) => {
    const latest = row.history[row.history.length - 1]!;
    const previous = row.history.length > 1 ? row.history[row.history.length - 2]! : null;
    return {
      product_id: row.product_id,
      product_name: row.product_name,
      product_name_am: row.product_name_am,
      category_id: row.category_id,
      unit: row.unit,
      market: row.market,
      currency: row.currency,
      price: latest.price,
      date: latest.date,
      previous_price: previous?.price ?? null,
      change_percent: previous && previous.price > 0
        ? Math.round(((latest.price - previous.price) / previous.price) * 1000) / 10
        : null,
      history: row.history,
    };
  });

  const [rate] = await database
    .select({
      base_currency: exchangeRates.baseCurrency,
      quote_currency: exchangeRates.quoteCurrency,
      rate: exchangeRates.rate,
      effective_at: exchangeRates.effectiveAt,
    })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.baseCurrency, "USD"), eq(exchangeRates.quoteCurrency, "ETB")))
    .orderBy(desc(exchangeRates.effectiveAt), desc(exchangeRates.createdAt))
    .limit(1);

  return {
    prices,
    exchange_rate: rate ? { ...rate, rate: Number(rate.rate) } : null,
  };
}
