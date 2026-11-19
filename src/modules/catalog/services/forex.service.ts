import { asc, desc, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../../infrastructure/database/db.js";
import { bankForexSnapshots } from "../../../infrastructure/database/schema.js";
import { httpsGet } from "../../legacy/source.js";

const rateValue = z.union([z.number(), z.string(), z.null()]).optional()
  .transform((value) => {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 && rate <= 10_000 ? rate : null;
  });
const snapshotSchema = z.object({
  id: z.union([z.number().int().safe(), z.string().min(1)]).transform(String),
  body: z.preprocess((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }, z.record(z.object({ buyPrice: rateValue, sellPrice: rateValue }))),
  source: z.string().nullish(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).nullish(),
});

export function parseBankForex(value: unknown) {
  const rows = z.array(snapshotSchema).parse(Array.isArray(value) ? value :
    value && typeof value === "object" && "data" in value ? value.data : value);
  return rows.map((row) => ({
    sourceId: row.id,
    effectiveAt: new Date(row.createdAt),
    sourceUpdatedAt: new Date(row.updatedAt ?? row.createdAt),
    source: row.source?.trim() || "ANKUARU",
    rates: Object.entries(row.body)
      .filter(([bank]) => bank.trim() && bank.toLowerCase() !== "average")
      .map(([bank, rates]) => ({ bank, buying: rates.buyPrice, selling: rates.sellPrice }))
      .sort((a, b) => a.bank.localeCompare(b.bank)),
  }));
}

export async function syncBankForex(database: Database, base: string, request: typeof fetch = fetch) {
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  const snapshots = parseBankForex(await httpsGet(url, request)("Admin/getAllExchangeRates"));
  if (!snapshots.length) return { snapshots: 0 };
  // Atomically save the validated feed. Corrections to a day's rates are picked up on later passes.
  await database.insert(bankForexSnapshots).values(snapshots).onConflictDoUpdate({
    target: bankForexSnapshots.sourceId,
    set: {
      effectiveAt: sql`excluded.effective_at`, sourceUpdatedAt: sql`excluded.source_updated_at`,
      source: sql`excluded.source`, rates: sql`excluded.rates`, syncedAt: sql`now()`,
    },
    setWhere: sql`excluded.source_updated_at >= ${bankForexSnapshots.sourceUpdatedAt}`,
  });
  return { snapshots: snapshots.length };
}

/** The latest snapshot, plus the one before it so the page can show each rate's change. */
export async function latestBankForex(database: Database) {
  const [snapshot, previous] = await database.select({
    effective_at: bankForexSnapshots.effectiveAt,
    synced_at: bankForexSnapshots.syncedAt,
    source: bankForexSnapshots.source,
    rates: bankForexSnapshots.rates,
  }).from(bankForexSnapshots)
    .orderBy(desc(bankForexSnapshots.effectiveAt), desc(bankForexSnapshots.sourceUpdatedAt), desc(bankForexSnapshots.sourceId)).limit(2);
  return {
    base_currency: "USD",
    quote_currency: "ETB",
    snapshot: snapshot ?? null,
    previous: previous ? { effective_at: previous.effective_at, rates: previous.rates } : null,
  };
}

/** Calendar day in Addis Ababa ("2026-11-19"), the day the banks publish their rates for. */
const addisDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Addis_Ababa", year: "numeric", month: "2-digit", day: "2-digit",
});

/**
 * One snapshot per Addis Ababa calendar day for the last `days` days, oldest first: the
 * day's latest (and latest-corrected) rates, for charts and the rates-by-date view.
 */
export async function bankForexHistory(database: Database, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await database.select({
    effective_at: bankForexSnapshots.effectiveAt,
    rates: bankForexSnapshots.rates,
  }).from(bankForexSnapshots)
    .where(gte(bankForexSnapshots.effectiveAt, since))
    .orderBy(asc(bankForexSnapshots.effectiveAt), asc(bankForexSnapshots.sourceUpdatedAt), asc(bankForexSnapshots.sourceId));
  // Later rows win, so each day keeps its last snapshot.
  const byDay = new Map<string, (typeof rows)[number]>();
  for (const row of rows) byDay.set(addisDay.format(row.effective_at), row);
  return {
    base_currency: "USD",
    quote_currency: "ETB",
    days: [...byDay].map(([date, row]) => ({ date, effective_at: row.effective_at, rates: row.rates })),
  };
}
