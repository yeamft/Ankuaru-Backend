import type { NodePgTransaction } from "drizzle-orm/node-postgres/session";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { Database } from "./db.js";
import type * as schema from "./schema.js";

export type DatabaseTransaction = NodePgTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export async function transaction<T>(
  database: Database,
  work: (
    tx: DatabaseTransaction,
  ) => Promise<T>,
): Promise<T> {
  return database.transaction(work);
}
