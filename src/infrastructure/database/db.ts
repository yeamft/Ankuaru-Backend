import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

/** Creates the typed Drizzle ORM over the shared PostgreSQL connection pool. */
export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
