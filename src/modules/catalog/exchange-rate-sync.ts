import { and, eq, gte, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/db.js";
import { transaction } from "../../infrastructure/database/index.js";
import { exchangeRates, traders } from "../../infrastructure/database/schema.js";

/**
 * Keeps the USD → ETB rate fresh from the National Bank of Ethiopia, whose
 * daily indicative rate is the weighted average of the commercial banks'
 * rates. NBE publishes on business days; each new NBE date is saved once.
 * An admin's manual entry for the same day wins.
 */

/** NBE's public API: the day's rates for USD, EUR and AED. Override with EXCHANGE_RATE_URL. */
export const DEFAULT_EXCHANGE_RATE_URL = "https://api.nbe.gov.et/api/get-selected-exchange-rates";
/** Trader row the automatic rates are recorded under (exchange_rates.created_by is required). */
export const RATE_SYNC_ID = "fx-rates";
/** Addis Ababa is UTC+3 all year (no daylight saving). */
const ADDIS_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Which NBE figure to publish: the weighted average (default), or the banks' buying or selling rate. */
export type RateSide = "weighted_average" | "buying" | "selling";

/** Midnight today in Addis Ababa, as a UTC instant. */
export function startOfAddisDay(now = new Date()) {
  const local = new Date(now.getTime() + ADDIS_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - ADDIS_OFFSET_MS);
}

type NbeRate = { buying?: string; selling?: string; weighted_average?: string; date?: string; currency?: { code?: string } };

/** Reads ETB per 1 USD, and the day NBE set it, from the NBE API. */
export async function fetchNbeUsdRate(
  url: string,
  side: RateSide = "weighted_average",
  fetcher: typeof fetch = fetch,
): Promise<{ rate: number; effectiveAt: Date }> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`NBE answered ${response.status}`);
  const body = (await response.json()) as { success?: boolean; data?: NbeRate[] };
  const usd = body.data?.find((row) => row.currency?.code === "USD");
  const rate = Number(usd?.[side]);
  // Sanity bounds so a broken response never becomes the headline number.
  if (!usd || !Number.isFinite(rate) || rate < 10 || rate > 10_000) throw new Error("NBE returned no usable USD rate");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(usd.date ?? "") ? usd.date : null;
  if (!day) throw new Error("NBE returned a USD rate without a date");
  // NBE's date is an Addis Ababa calendar day; the rate applies from its start.
  return { rate, effectiveAt: new Date(`${day}T00:00:00+03:00`) };
}

export type RateSyncResult = { status: "up_to_date" } | { status: "saved"; rate: number; effectiveAt: Date };

export async function syncExchangeRate(
  database: Database,
  {
    url = DEFAULT_EXCHANGE_RATE_URL,
    side = "weighted_average" as RateSide,
    now = new Date(),
    fetcher = fetch as typeof fetch,
  } = {},
): Promise<RateSyncResult> {
  const usdEtbSince = (from: Date) => and(
    eq(exchangeRates.baseCurrency, "USD"),
    eq(exchangeRates.quoteCurrency, "ETB"),
    gte(exchangeRates.effectiveAt, from),
  );
  // Already have a rate for today: nothing to ask NBE.
  const [today] = await database.select({ id: exchangeRates.id }).from(exchangeRates)
    .where(usdEtbSince(startOfAddisDay(now))).limit(1);
  if (today) return { status: "up_to_date" };

  const { rate, effectiveAt } = await fetchNbeUsdRate(url, side, fetcher);
  return transaction(database, async (tx) => {
    // One writer at a time across API instances; re-check under the lock.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('exchange-rate-sync'))`);
    // Weekends and holidays: NBE still shows the last business day's rate, which we already saved.
    const [existing] = await tx.select({ id: exchangeRates.id }).from(exchangeRates)
      .where(usdEtbSince(effectiveAt)).limit(1);
    if (existing) return { status: "up_to_date" } as const;

    await tx.insert(traders).values({
      id: RATE_SYNC_ID,
      displayName: "National Bank of Ethiopia",
      status: "Active",
      verificationTier: "registered",
      verified: false,
      phoneVerified: false,
      role: "both",
    }).onConflictDoNothing();
    await tx.insert(exchangeRates).values({
      baseCurrency: "USD",
      quoteCurrency: "ETB",
      rate: rate.toFixed(4),
      effectiveAt,
      createdBy: RATE_SYNC_ID,
    });
    return { status: "saved", rate, effectiveAt } as const;
  });
}

/**
 * Checks every hour (cheap: one indexed query once today's rate is saved), so
 * NBE's new rate lands within an hour of being published and a failed fetch
 * is retried.
 */
export function startExchangeRateSync(
  database: Database,
  url: string,
  side: RateSide = "weighted_average",
  intervalMs = 60 * 60 * 1000,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await syncExchangeRate(database, { url, side });
      if (result.status === "saved") {
        console.log(`NBE rate saved: 1 USD = ${result.rate} ETB (${result.effectiveAt.toISOString().slice(0, 10)})`);
      }
    } catch (error) {
      console.error(`Exchange rate sync failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 20_000);
  const timer = setInterval(() => void tick(), intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
