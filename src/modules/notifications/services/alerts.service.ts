import { and, asc, count, eq } from "drizzle-orm";
import type { Database } from "../../../infrastructure/database/db.js";
import { listingAlerts } from "../../../infrastructure/database/schema.js";
import { ApiError } from "../../../shared/errors.js";
import { isUuid, parse } from "../../../shared/validation.js";
import { ALERT_LIMIT, alertBodySchema, type AlertInput } from "../schemas.js";

type AlertRow = typeof listingAlerts.$inferSelect;

const decimal = (value: string | null) => (value === null ? null : Number(value));
const stored = (value: number | null) => (value === null ? null : String(value));

function present(row: AlertRow) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    intent: row.intent,
    categories: row.categories,
    products: row.products,
    keyword: row.keyword,
    regions: row.regions,
    processes: row.processes,
    transaction_types: row.transactionTypes,
    grades: row.grades,
    statuses: row.statuses,
    min_quantity: decimal(row.minQuantity),
    max_quantity: decimal(row.maxQuantity),
    price_currency: row.priceCurrency,
    min_price: decimal(row.minPrice),
    max_price: decimal(row.maxPrice),
    seller_verification: row.sellerVerification,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function columns(input: AlertInput) {
  return {
    name: input.name,
    enabled: input.enabled,
    intent: input.intent,
    categories: input.categories,
    products: input.products,
    keyword: input.keyword,
    regions: input.regions,
    processes: input.processes,
    transactionTypes: input.transaction_types,
    grades: input.grades,
    statuses: input.statuses,
    minQuantity: stored(input.min_quantity),
    maxQuantity: stored(input.max_quantity),
    // A currency without a range would filter out every unpriced listing.
    priceCurrency: input.min_price === null && input.max_price === null ? null : input.price_currency,
    minPrice: stored(input.min_price),
    maxPrice: stored(input.max_price),
    sellerVerification: input.seller_verification,
  };
}

const notFound = () => new ApiError(404, "alert_not_found", "Alert not found.");

export async function listAlerts(database: Database, accountId: string) {
  const rows = await database.select().from(listingAlerts)
    .where(eq(listingAlerts.accountId, accountId)).orderBy(asc(listingAlerts.createdAt));
  return rows.map(present);
}

export async function createAlert(database: Database, accountId: string, body: unknown) {
  const input = parse(alertBodySchema, body, "invalid_alert");
  const [existing] = await database.select({ total: count() }).from(listingAlerts)
    .where(eq(listingAlerts.accountId, accountId));
  if ((existing?.total ?? 0) >= ALERT_LIMIT) {
    throw new ApiError(409, "alert_limit", `You can keep up to ${ALERT_LIMIT} listing alerts.`);
  }
  const [row] = await database.insert(listingAlerts)
    .values({ accountId, ...columns(input) }).returning();
  return present(row!);
}

export async function replaceAlert(database: Database, accountId: string, alertId: string, body: unknown) {
  if (!isUuid(alertId)) throw notFound();
  const input = parse(alertBodySchema, body, "invalid_alert");
  const [row] = await database.update(listingAlerts)
    .set({ ...columns(input), updatedAt: new Date() })
    .where(and(eq(listingAlerts.id, alertId), eq(listingAlerts.accountId, accountId)))
    .returning();
  if (!row) throw notFound();
  return present(row);
}

export async function deleteAlert(database: Database, accountId: string, alertId: string) {
  if (!isUuid(alertId)) throw notFound();
  const [row] = await database.delete(listingAlerts)
    .where(and(eq(listingAlerts.id, alertId), eq(listingAlerts.accountId, accountId)))
    .returning({ id: listingAlerts.id });
  if (!row) throw notFound();
}
