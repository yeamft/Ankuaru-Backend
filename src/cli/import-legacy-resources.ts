import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { createDatabase, createPool, migrate } from "../infrastructure/database/index.js";
import { fetchLegacyResources, importLegacyResources } from "../modules/legacy/resource-source.js";
import { legacySyncOptions } from "../modules/legacy/sync.js";

// Imports only resources from the legacy API, without the slower full sync.
const options = legacySyncOptions();
if (!options.token) {
  console.error("Set LEGACY_API_TOKEN in backend/.env to import resources; Admin/fetchallresource requires a legacy staff token.");
  process.exit(1);
}
const pool = createPool(loadConfig().databaseUrl, 2);
try {
  const applied = await migrate(pool);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  const fetched = await fetchLegacyResources(options.baseUrl, options.token);
  const byType: Record<string, number> = {};
  for (const resource of fetched.resources) byType[resource.type] = (byType[resource.type] ?? 0) + 1;
  console.log(`Fetched ${fetched.resources.length} posted resources` +
    (fetched.skipped ? ` (${fetched.skipped} incomplete skipped)` : "") +
    (fetched.resources.length ? `: ${Object.entries(byType).map(([type, count]) => `${count} ${type}`).join(", ")}` : ""));
  const result = await importLegacyResources(createDatabase(pool), fetched.resources);
  console.log(`${result.resourcesInserted} resources added, ${result.resourcesUpdated} updated.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
