import type { Pool, PoolClient } from "pg";
import type { Database } from "../../infrastructure/database/db.js";
import { legacyNewsImports } from "../../infrastructure/database/schema.js";
import { importLegacyData, importLegacyNews } from "./import.js";
import { DEFAULT_SINCE, fetchLegacyData, fetchLegacyNews } from "./source.js";
import { DEFAULT_CONTENT_SINCE, fetchLegacyContent } from "./content-source.js";
import { syncBankForex } from "../catalog/services/forex.service.js";

export const DEFAULT_LEGACY_API = "https://backend.ankuaru.com/api";

export type LegacySyncOptions = {
  baseUrl: string;
  /** Offers created before this are ignored. */
  since: string;
  /** Posts created before this are ignored. */
  newsSince: string;
  contentSince?: string;
  listings: boolean;
};

export function legacySyncOptions(environment = process.env): LegacySyncOptions {
  const since = environment.LEGACY_IMPORT_SINCE ?? DEFAULT_SINCE;
  return {
    baseUrl: environment.LEGACY_API_BASE_URL ?? DEFAULT_LEGACY_API,
    since,
    newsSince: environment.LEGACY_NEWS_SINCE ?? since,
    contentSince: environment.LEGACY_CONTENT_SINCE ?? DEFAULT_CONTENT_SINCE,
    listings: environment.LEGACY_SKIP_LISTINGS !== "1",
  };
}

export type LegacySyncResult = {
  news?: Awaited<ReturnType<typeof importLegacyNews>>;
  listings?: Awaited<ReturnType<typeof importLegacyData>>;
  posts?: Awaited<ReturnType<typeof importLegacyNews>>;
  tender?: Awaited<ReturnType<typeof importLegacyNews>>;
  event?: Awaited<ReturnType<typeof importLegacyNews>>;
  forex?: Awaited<ReturnType<typeof syncBankForex>>;
  errors: string[];
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Independent feeds: news, typed tenders/events, bank rates, then listings.
 * Each failure is isolated so other feeds still run and failures retry next pass.
 */
export async function runLegacySync(
  database: Database,
  options: LegacySyncOptions,
  { reimportNews = false, fetcher = fetch }: { reimportNews?: boolean; fetcher?: typeof fetch } = {},
): Promise<LegacySyncResult> {
  const result: LegacySyncResult = { errors: [] };
  try {
    const known = reimportNews
      ? new Set<string>()
      : new Set((await database.select({ id: legacyNewsImports.sourceId }).from(legacyNewsImports))
        .map(({ id }) => id));
    const news = await fetchLegacyNews(options.baseUrl, options.newsSince, fetcher, known);
    result.news = await importLegacyNews(database, news);
  } catch (error) {
    result.errors.push(`news: ${message(error)}`);
  }
  // The admin posts feed carries current news (the UserService feed above stopped in May 2025).
  for (const kind of ["news", "tender", "event"] as const) {
    try {
      // Images can be added to existing posts, including older pages of the archive.
      const content = await fetchLegacyContent(options.baseUrl, kind, options.contentSince, fetcher);
      result[kind === "news" ? "posts" : kind] = await importLegacyNews(database, content);
    } catch (error) {
      result.errors.push(`${kind}: ${message(error)}`);
    }
  }
  try {
    result.forex = await syncBankForex(database, options.baseUrl, fetcher);
  } catch (error) {
    result.errors.push(`forex: ${message(error)}`);
  }
  if (options.listings) {
    try {
      const data = await fetchLegacyData(options.baseUrl, options.since, fetcher);
      result.listings = await importLegacyData(database, data);
    } catch (error) {
      result.errors.push(`listings: ${message(error)}`);
    }
  }
  return result;
}

export function describeLegacySync(result: LegacySyncResult): string {
  const parts: string[] = [];
  if (result.news) {
    parts.push(`${result.news.newsInserted} posts added, ${result.news.newsUpdated} reclassified`);
  }
  if (result.posts) parts.push(`${result.posts.newsInserted} news posts added, ${result.posts.newsUpdated} updated`);
  if (result.tender) parts.push(`${result.tender.newsInserted} tenders added, ${result.tender.newsUpdated} updated`);
  if (result.event) parts.push(`${result.event.newsInserted} events added, ${result.event.newsUpdated} updated`);
  if (result.forex) parts.push(`${result.forex.snapshots} bank rate snapshots synced`);
  if (result.listings) {
    parts.push(
      `${result.listings.usersInserted} profiles and ${result.listings.listingsInserted} listings added, ` +
      `${result.listings.listingsUpdated} listings reopened/closed`,
    );
  }
  return parts.join("; ") || "nothing synced";
}

/**
 * Re-runs the sync on an interval inside the API process. A Postgres session lock
 * keeps several API instances from syncing at the same time, and a run is skipped
 * while the previous one is still going.
 */
export function startLegacySync(
  pool: Pool,
  database: Database,
  intervalMs: number,
  options = legacySyncOptions(),
): () => void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      const { rows } = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext('legacy-ankuaru-sync')) as locked",
      );
      if (!rows[0]?.locked) return;
      try {
        const started = Date.now();
        const result = await runLegacySync(database, options);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`Legacy sync (${seconds}s): ${describeLegacySync(result)}`);
        for (const error of result.errors) console.error(`Legacy sync failed for ${error}`);
      } finally {
        await client.query("select pg_advisory_unlock(hashtext('legacy-ankuaru-sync'))");
      }
    } catch (error) {
      console.error(`Legacy sync failed: ${message(error)}`);
    } finally {
      client?.release();
      running = false;
    }
  };

  // First pass shortly after startup so it does not compete with boot.
  const first = setTimeout(() => void tick(), 15_000);
  const timer = setInterval(() => void tick(), intervalMs);
  first.unref();
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
