import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { describeLegacySync, legacySyncOptions, runLegacySync } from "../modules/legacy/sync.js";

// One manual pass. The API server also runs this on an interval (LEGACY_SYNC_INTERVAL_MINUTES).
// Pass --recheck-news to re-read every post since the cutoff and refresh its tender/event/news kind.
const options = legacySyncOptions();
const pool = createPool(loadConfig().databaseUrl, 2);
try {
  const applied = await migrate(pool);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  const result = await runLegacySync(createDatabase(pool), options, {
    reimportNews: process.argv.includes("--recheck-news"),
  });
  console.log(`Legacy import from ${options.baseUrl}: ${describeLegacySync(result)}.`);
  for (const error of result.errors) console.error(`Failed: ${error}`);
  if (result.errors.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
