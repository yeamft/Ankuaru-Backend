import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { importLegacyData, importLegacyNews } from "../modules/legacy/import.js";
import { DEFAULT_SINCE, fetchLegacyData, fetchLegacyNews } from "../modules/legacy/source.js";

const since = process.env.LEGACY_IMPORT_SINCE ?? DEFAULT_SINCE;
const newsSince = process.env.LEGACY_NEWS_SINCE ?? since;
const baseUrl = process.env.LEGACY_API_BASE_URL ?? "https://backend.ankuaru.com/api";

try {
  const news = await fetchLegacyNews(baseUrl, newsSince);
  const byKind = { News: 0, Tender: 0, Event: 0 };
  for (const item of news.news) byKind[item.kind]++;
  console.log(`Fetched ${news.news.length} posts (${byKind.News} news, ${byKind.Tender} tenders, ${byKind.Event} events).`);
  const pool = createPool(loadConfig().databaseUrl, 1);
  try {
    const applied = await migrate(pool);
    if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
    const database = createDatabase(pool);
    const newsResult = await importLegacyNews(database, news);
    console.log(
      `Legacy news import complete: ${newsResult.newsInserted} added, ${newsResult.newsUpdated} reclassified; ` +
      `${newsResult.newsSeen} posts checked from ${newsSince}.`,
    );
    if (process.env.LEGACY_SKIP_LISTINGS !== "1") {
      const data = await fetchLegacyData(baseUrl, since);
      const result = await importLegacyData(database, data);
      console.log(
        `Legacy listing import complete: ${result.usersInserted} profiles and ${result.listingsInserted} listings added; ` +
        `${result.usersSeen} profiles and ${result.offersSeen} listings checked.`,
      );
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
